/** Why the user center refused a request, for the service that sent it to report. */

/** The user center's reason for a refusal, and its HTTP status. */
export interface UserCenterRefusal {
  readonly reason: string
  readonly status: number
}

/**
 * Read the user center's own words for a refusal, or its status when the body carries none.
 * @param res - the user center's answer that was not ok.
 * @returns the reason and the status.
 */
export async function userCenterRefusal(res: Response): Promise<UserCenterRefusal> {
  const body: unknown = await res.json().catch(() => undefined)
  const message = typeof body === 'object' && body !== null && 'message' in body ? body.message : undefined
  const reason = Array.isArray(message) ? message.join('；') : typeof message === 'string' ? message : `the user center answered ${String(res.status)}`
  return { reason, status: res.status }
}
