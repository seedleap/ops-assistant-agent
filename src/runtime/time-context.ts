import type { ISODateString } from "../domain/types.js";

export const DEFAULT_TIMEZONE = "UTC";

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export interface RequestTimeContext {
  current_time_utc: ISODateString;
  timezone: string;
  local_time: string;
  timezone_source: "request" | "memory" | "default";
}

export function buildRequestTimeContext(
  requestTime: ISODateString,
  requestedTimezone?: string,
  rememberedTimezone?: string,
): RequestTimeContext {
  const timezone = requestedTimezone || rememberedTimezone || DEFAULT_TIMEZONE;
  const source = requestedTimezone ? "request" : rememberedTimezone ? "memory" : "default";
  const localTime = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  }).format(new Date(requestTime));
  return {
    current_time_utc: requestTime,
    timezone,
    local_time: localTime,
    timezone_source: source,
  };
}
