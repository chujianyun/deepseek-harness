/** Keep a service on the tenant the user center is signed in as. */
import type { HubAccountView } from './types.ts'

/** What `followTenant` reads the signed-in tenant from: the hub account service. */
export interface TenantSource {
  getState(): Promise<HubAccountView>
  watch(signal: AbortSignal): AsyncIterable<HubAccountView>
}

/**
 * Switch to the signed-in tenant now, then again whenever it changes, for as long as the signal lives.
 * @param hub - the hub account service.
 * @param signal - the following service's lifetime.
 * @param current - the tenant the service holds.
 * @param switchTo - switches the service; the caller serializes it with its other writes.
 * @param logger - warned, under `owner`, of a background switch that failed; following goes on with the next change.
 * @param owner - the following service's name for the warning.
 * @returns once the first switch is done; later switches run in the background.
 * @throws whatever the first switch throws.
 */
export async function followTenant(
  hub: TenantSource, signal: AbortSignal, current: () => string | null,
  switchTo: (tenantId: string | null) => Promise<void>, logger: { warn(message: string): void }, owner: string,
): Promise<void> {
  await switchTo((await hub.getState()).profile?.tenantId ?? null)
  void (async () => {
    for await (const state of hub.watch(signal)) {
      const tenantId = state.profile?.tenantId ?? null
      if (tenantId !== current()) await switchTo(tenantId).catch((error: unknown) => {
        logger.warn(`${owner}: switching to tenant ${String(tenantId)} failed: ${String(error)}`)
      })
    }
  })()
}
