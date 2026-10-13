/** Types of the `assistantPackages` Host service and its Remote namespace. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The company has no assistant package with this id, or it was deleted. */
    'assistant-packages/not-found': { readonly packageId: string }
    /** The downloaded package does not match what the user center published, or breaks the package rules. */
    'assistant-packages/invalid': { readonly reason: string }
    /** The user center cannot be reached or answered with an error. */
    'assistant-packages/unavailable': { readonly status: number | null }
    /** The assistant was not installed from a package on this machine. */
    'assistant-packages/not-installed': { readonly assistantId: string }
    /** The package has no recommended task with this id. */
    'assistant-packages/task-not-found': { readonly assistantId: string; readonly taskId: string }
  }
}

/**
 * When a recommended task runs: every day, on ISO weekdays (Monday 1 through Sunday 7), or by a five-field
 * cron expression; times are local HH:mm.
 */
export type AssistantPackageTaskTiming =
  | { readonly kind: 'daily'; readonly time: string }
  | { readonly kind: 'weekly'; readonly weekdays: readonly number[]; readonly time: string }
  | { readonly kind: 'cron'; readonly expression: string }

/** One recommended scheduled task of a package; installed switched off, created as an automation task when the user switches it on. */
export interface AssistantPackageTask {
  /** Unique within the package; keeps a task's identity across package versions. */
  readonly id: string
  readonly title: string
  /** Instruction sent to the task's Session at each run. */
  readonly prompt: string
  readonly timing: AssistantPackageTaskTiming
  /** IANA zone the timing is read in. */
  readonly timeZone: string
  /** Connectors whose plain writes run without asking in the task's Session. */
  readonly connectors: readonly string[]
  /** Permission preset of the task's Session; absent keeps the default. */
  readonly permission?: string
  /**
   * Operations its scheduled runs may run without asking, as a command's first words such as
   * `lark-cli im +messages-send`; absent declares none.
   */
  readonly operations?: readonly string[]
}

/** A package's `agent.json`. Absent `skills` or `connectors` allows every one. */
export interface AssistantPackageManifest {
  /** Slug unique within the company. */
  readonly name: string
  readonly displayName: string
  readonly description: string
  /** x.y.z */
  readonly version: string
  /** Built-in avatar key. */
  readonly avatar?: string
  /** Agent preset the assistant runs. */
  readonly preset?: string
  readonly skills?: readonly string[]
  readonly connectors?: readonly string[]
  readonly tasks: readonly AssistantPackageTask[]
}

/** One package the company published, as the user center lists it for this employee. */
export interface AssistantPackageItem {
  /** User center package id. */
  readonly id: string
  readonly name: string
  /** Current version. */
  readonly version: string
  readonly manifest: AssistantPackageManifest
  /** ISO time the current version was uploaded. */
  readonly updatedAt: string
  /** Assistant installed from this package on this machine, when any. */
  readonly installedAssistantId: string | null
}

/** A recommended task of an installed assistant, with whether it runs. */
export interface InstalledTaskView extends AssistantPackageTask {
  /** The automation task while switched on; null while switched off. */
  readonly enabled: { readonly sessionId: string; readonly scheduleId: string; readonly version: string } | null
  /** Switched on from an earlier version whose definition of this task differs; switching it off and on applies the new one. */
  readonly outdated: boolean
}

/** An assistant installed from a package. */
export interface InstalledPackageView {
  readonly assistantId: string
  readonly packageId: string
  readonly name: string
  /** Name shown to people, from the installed version. */
  readonly displayName: string
  /** Version installed or last updated to. */
  readonly version: string
  /** Current version on the user center when known and newer; null otherwise. */
  readonly updateVersion: string | null
  readonly tasks: readonly InstalledTaskView[]
  /** Skills the package names that are neither installed nor on the company's Skill Hub. */
  readonly missingSkills: readonly string[]
}

/** The packages offered to the signed-in employee and those installed here. */
export interface AssistantPackagesState {
  /** Tenant of the current Hub sign-in; null while signed out. */
  readonly tenantId: string | null
  /** Packages the company published; null while signed out or when the user center could not be read. */
  readonly packages: readonly AssistantPackageItem[] | null
  /** Why `packages` is null although signed in. */
  readonly unavailable: boolean
  readonly installed: readonly InstalledPackageView[]
}

/** What installing or updating did. */
export interface AssistantPackageInstallResult {
  readonly assistantId: string
  readonly version: string
  /** Skills installed from the company's Skill Hub. */
  readonly installedSkills: readonly string[]
  /** Skills the package names but the Skill Hub does not offer. */
  readonly missingSkills: readonly string[]
  /** Core files kept because the user changed them since the package wrote them (updates only). */
  readonly keptFiles: readonly string[]
  readonly state: AssistantPackagesState
}
