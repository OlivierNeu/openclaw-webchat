/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as anomalies from "../anomalies.js";
import type * as apiKeys from "../apiKeys.js";
import type * as auth from "../auth.js";
import type * as bridge from "../bridge.js";
import type * as bridge_ingest from "../bridge_ingest.js";
import type * as chats from "../chats.js";
import type * as crons from "../crons.js";
import type * as dev from "../dev.js";
import type * as http from "../http.js";
import type * as integrations_config from "../integrations/config.js";
import type * as integrations_langfuse from "../integrations/langfuse.js";
import type * as integrations_opik from "../integrations/opik.js";
import type * as integrations_shared from "../integrations/shared.js";
import type * as integrations_ship from "../integrations/ship.js";
import type * as integrations_status from "../integrations/status.js";
import type * as kpi from "../kpi.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_apiAuth from "../lib/apiAuth.js";
import type * as lib_apikeys from "../lib/apikeys.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_rbac from "../lib/rbac.js";
import type * as me from "../me.js";
import type * as messages from "../messages.js";
import type * as observability from "../observability.js";
import type * as openclaw from "../openclaw.js";
import type * as projects from "../projects.js";
import type * as routing from "../routing.js";
import type * as send from "../send.js";
import type * as stream from "../stream.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  anomalies: typeof anomalies;
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  bridge: typeof bridge;
  bridge_ingest: typeof bridge_ingest;
  chats: typeof chats;
  crons: typeof crons;
  dev: typeof dev;
  http: typeof http;
  "integrations/config": typeof integrations_config;
  "integrations/langfuse": typeof integrations_langfuse;
  "integrations/opik": typeof integrations_opik;
  "integrations/shared": typeof integrations_shared;
  "integrations/ship": typeof integrations_ship;
  "integrations/status": typeof integrations_status;
  kpi: typeof kpi;
  "lib/access": typeof lib_access;
  "lib/apiAuth": typeof lib_apiAuth;
  "lib/apikeys": typeof lib_apikeys;
  "lib/audit": typeof lib_audit;
  "lib/rbac": typeof lib_rbac;
  me: typeof me;
  messages: typeof messages;
  observability: typeof observability;
  openclaw: typeof openclaw;
  projects: typeof projects;
  routing: typeof routing;
  send: typeof send;
  stream: typeof stream;
  uploads: typeof uploads;
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
