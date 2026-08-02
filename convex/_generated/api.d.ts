/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assets from "../assets.js";
import type * as bursts from "../bursts.js";
import type * as crons from "../crons.js";
import type * as director from "../director.js";
import type * as lib_capabilities from "../lib/capabilities.js";
import type * as lib_runtime from "../lib/runtime.js";
import type * as participants from "../participants.js";
import type * as renderJobs from "../renderJobs.js";
import type * as sessions from "../sessions.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  assets: typeof assets;
  bursts: typeof bursts;
  crons: typeof crons;
  director: typeof director;
  "lib/capabilities": typeof lib_capabilities;
  "lib/runtime": typeof lib_runtime;
  participants: typeof participants;
  renderJobs: typeof renderJobs;
  sessions: typeof sessions;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
