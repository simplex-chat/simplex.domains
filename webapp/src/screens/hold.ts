// a wait the service asked for: when it ends, on the service's clock, and the words said before the countdown
export interface Hold { until: number; lead: string }
export const NO_LEAD = ""
export const LIMITED_LEAD = "Too many attempts. Please "
export const PLEASE_LEAD = "Please "
