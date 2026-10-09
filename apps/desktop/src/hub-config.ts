/**
 * The user center Desktop signs in to. A packaged application carries the release's settings in its
 * manifest (`dshHub`); `DSH_HUB_ORIGIN` in the Host environment replaces them, so development and test
 * launches point at their own user center.
 */

/** The failure text the fatal dialog recognizes; the dialog states the localized fix instead. */
export const HUB_NOT_CONFIGURED = 'desktop: no user center is configured'

/** User-center settings bundled into a packaged Desktop. */
export interface DesktopHubConfig {
  readonly origin: string
  readonly clientId: string
}

/**
 * Validate the manifest's bundled user-center settings.
 * @param value - The packaged manifest's `dshHub` field, or `undefined` when it has none.
 * @returns The bundled settings, or `undefined` when the manifest carries none.
 * @throws Error when the field is present but malformed.
 */
export function resolveDesktopHubConfig(value: unknown): DesktopHubConfig | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || !('origin' in value) || !('clientId' in value)
    || typeof value.origin !== 'string' || typeof value.clientId !== 'string' || value.clientId === '') {
    throw new Error('desktop: invalid bundled user-center settings')
  }
  const url = URL.parse(value.origin)
  if (url?.protocol !== 'https:' || url.origin !== value.origin) throw new Error('desktop: invalid bundled user-center origin')
  return { origin: value.origin, clientId: value.clientId }
}

/**
 * The Host environment with the user center filled in.
 * @param environment - The environment the Host would otherwise receive.
 * @param bundled - The packaged application's settings, if any.
 * @returns `environment` unchanged when it names a user center, otherwise with the bundled settings added.
 * @throws Error carrying {@link HUB_NOT_CONFIGURED} when neither supplies a user center.
 */
export function desktopHubEnvironment(environment: NodeJS.ProcessEnv, bundled: DesktopHubConfig | undefined): NodeJS.ProcessEnv {
  if (environment['DSH_HUB_ORIGIN'] !== undefined && environment['DSH_HUB_ORIGIN'] !== '') return environment
  if (bundled === undefined) throw new Error(`${HUB_NOT_CONFIGURED} (DSH_HUB_ORIGIN and DSH_HUB_CLIENT_ID)`)
  return { ...environment, DSH_HUB_ORIGIN: bundled.origin, DSH_HUB_CLIENT_ID: bundled.clientId }
}
