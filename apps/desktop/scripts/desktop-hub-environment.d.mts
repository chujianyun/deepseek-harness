/** User-center settings bundled into a packaged Desktop. */
export interface DesktopHubEnvironment {
  origin: string
  clientId: string
}

/**
 * Resolve the bundled user-center settings before preparing artifacts or accessing signing hardware.
 * @param environment File-owned release settings; both values are required.
 * @returns The HTTPS user-center origin and its registered DSH client id.
 */
export function resolveDesktopHubEnvironment(environment: NodeJS.ProcessEnv): DesktopHubEnvironment
