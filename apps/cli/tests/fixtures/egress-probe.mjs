/** On-demand egress probe: dials exactly the URL its caller names, only when asked. */

export const name = 'egress-probe'

/**
 * @param ctx - plugin context receiving the probe service.
 * @returns nothing; the service outlives the boot for the control case.
 */
export function apply(ctx) {
  ctx.provide('egressProbe', {
    /**
     * Fetch one URL and report the outcome without failing its caller.
     * @param {string} url - destination the probe dials.
     * @returns the HTTP status, or 0 when the request never completed.
     */
    async ping(url) {
      try {
        const response = await fetch(url)
        await response.arrayBuffer()
        return response.status
      } catch {
        return 0
      }
    },
  })
}
