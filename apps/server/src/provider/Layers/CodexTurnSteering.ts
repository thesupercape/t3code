import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const decodeSteeringThread = Schema.decodeUnknownEffect(
  Schema.Struct({
    thread: Schema.Struct({
      id: Schema.String,
      turns: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
    }),
  }),
);

export function withCodexDeliveryDeadline<A>(
  method: "thread/read" | "turn/steer" | "turn/start",
  request: Effect.Effect<A, CodexErrors.CodexAppServerError>,
) {
  return request.pipe(
    Effect.timeoutOption(method === "thread/read" ? "90 seconds" : "10 seconds"),
    Effect.flatMap((result) =>
      result._tag === "Some"
        ? Effect.succeed(result.value)
        : CodexErrors.CodexAppServerRequestError.internalError(
            `Steering ${method} timed out. Delivery is not confirmed; do not retry automatically.`,
            undefined,
            { method },
          ),
    ),
  );
}

/** Only a provider's explicit pre-delivery turn mismatch permits another send. */
function isRejectedStaleTurn(error: CodexErrors.CodexAppServerError): boolean {
  return (
    isRequestError(error) &&
    error.operation === "receive-response" &&
    error.method === "turn/steer" &&
    error.code === -32600 &&
    /^(?:active turn mismatch|expected turn id .+ (?:does not match|but found) .+)$/i.test(
      error.errorMessage,
    )
  );
}

/** Null means verified idle, never a failed or ambiguous read. */
export const readCodexActiveTurn = Effect.fn("readCodexActiveTurn")(function* (input: {
  readonly providerThreadId: string;
  readonly readThread: Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
}) {
  // Native Codex can add item variants before our generated protocol catches
  // up. Steering needs only parent identity and turn status, never item data.
  const snapshot = yield* withCodexDeliveryDeadline("thread/read", input.readThread).pipe(
    Effect.flatMap((response) =>
      decodeSteeringThread(response).pipe(
        Effect.mapError((error) =>
          CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
            "decode-response-payload",
            error,
            { method: "thread/read" },
          ),
        ),
      ),
    ),
  );
  const active = snapshot.thread.turns.filter((turn) => turn.status === "inProgress");
  const [turn] = active;
  if (
    snapshot.thread.id !== input.providerThreadId ||
    active.length > 1 ||
    snapshot.thread.turns.some(
      (entry) => !["inProgress", "completed", "interrupted", "failed"].includes(entry.status),
    )
  ) {
    return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
      "Message was not sent: the bound provider thread state is ambiguous or has the wrong identity.",
    );
  }
  return turn?.id ?? null;
});

/** Resolve only the bound parent thread; never infer its active turn from T3 projections. */
export const steerCodexActiveTurn = Effect.fn("steerCodexActiveTurn")(function* (input: {
  readonly providerThreadId: string;
  readonly readThread: Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  readonly initialActiveTurnId?: string;
  readonly steerTurn: (
    turnId: string,
  ) => Effect.Effect<{ readonly turnId: string }, CodexErrors.CodexAppServerError>;
}) {
  const readActiveTurn = Effect.gen(function* () {
    const turnId = yield* readCodexActiveTurn(input);
    if (turnId === null) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Steering was not sent: the bound provider thread has no unambiguous active turn.",
      );
    }
    return turnId;
  });

  let activeTurnId = input.initialActiveTurnId ?? (yield* readActiveTurn);
  let response = yield* withCodexDeliveryDeadline("turn/steer", input.steerTurn(activeTurnId)).pipe(
    Effect.result,
  );
  if (response._tag === "Failure" && isRejectedStaleTurn(response.failure)) {
    const refreshedTurnId = yield* readActiveTurn;
    if (refreshedTurnId !== activeTurnId) {
      activeTurnId = refreshedTurnId;
      response = yield* withCodexDeliveryDeadline("turn/steer", input.steerTurn(activeTurnId)).pipe(
        Effect.result,
      );
    }
  }
  if (response._tag === "Failure") return yield* response.failure;
  if (response.success.turnId !== activeTurnId) {
    return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
      "Steering delivery is uncertain: the provider returned a different turn ID. Do not retry automatically.",
    );
  }
  return response.success;
});
