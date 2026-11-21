import { randomBytes } from "node:crypto";
import { SCREEN_PROTOCOL } from "../src/screen-session";

export const screenSecret = randomBytes(32).toString("hex");
export const screenProtocols = [SCREEN_PROTOCOL, screenSecret];
export const screenHeaders = { Authorization: `Bearer ${screenSecret}` };
