import { createFileRoute } from "@tanstack/react-router";
import { UsageResetPage } from "../components/usage/UsageResetPage";

export const Route = createFileRoute("/usage-resets")({ component: UsageResetPage });
