import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("expire stale CrowdCut cameras", { seconds: 5 }, internal.participants.expireStale, {});

export default crons;

