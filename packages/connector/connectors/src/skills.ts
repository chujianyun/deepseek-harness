/**
 * The Skills a connected connector gives the model: the ones its CLI release ships, listed and
 * loaded through the connector's driver, so they always match the installed CLI version.
 */
import type {
  SkillCandidate, SkillDefinition, SkillInvocationPolicy, SkillProvider, SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import type { ConnectorDriver, SkillLocation } from './driver.ts'
import type { ConnectorSkillView } from './types.ts'

/** Provider name in the skill registry. */
export const CONNECTOR_SKILL_PROVIDER = 'connectors'

/**
 * Rank of connector Skills: above the user's own Skill directories, so a stale copy of a CLI's
 * Skill there never shadows the one matching the installed CLI, and below project Skills. The
 * provider is registered for every layer, so this order also holds in a preset's own layer.
 */
export const CONNECTOR_SKILL_RANK = 350

const OPEN: SkillInvocationPolicy = Object.freeze({ modelInvocable: true, userInvocable: true })

/** One connector whose Skills reach the model now. */
export interface SkillSource {
  /** Skill source label, such as `connector-feishu`. */
  readonly source: string
  /** The CLI version, which keys the cached list. */
  readonly version: string
  readonly driver: ConnectorDriver
  /** The installed CLI, run for the current tenant. */
  readonly location: SkillLocation
}

/** A Skill a connector's CLI ships. */
export type ConnectorSkill = ConnectorSkillView

/** Lists and loads the Skills of the connectors that are connected and enabled now. */
export class ConnectorSkillProvider implements SkillProvider {
  readonly name = CONNECTOR_SKILL_PROVIDER
  private readonly cache = new Map<string, Promise<readonly ConnectorSkill[]>>()

  /**
   * @param sources - the connectors whose Skills reach the model now.
   * @param control - the registration's lifetime and invalidation.
   */
  constructor(private readonly sources: () => readonly SkillSource[], private readonly control: SkillProviderControl) {}

  /**
   * List the connected connectors' Skills; a CLI that cannot list them contributes none.
   * @returns the candidates.
   */
  async list(): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    for (const source of this.sources()) {
      for (const skill of await this.skills(source)) {
        candidates.push({
          name: skill.name, description: skill.description, invocation: OPEN, source: source.source,
          provider: this.name, rank: CONNECTOR_SKILL_RANK, locator: source.source,
          resourceBase: source.driver.skillResources(source.location, skill.name),
        })
      }
    }
    return candidates
  }

  /**
   * Load a Skill's instructions from the CLI release.
   * @param candidate - the listed candidate.
   * @returns the definition, or undefined when its connector no longer gives Skills or the CLI cannot read it.
   */
  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const source = this.sources().find(item => item.source === candidate.locator)
    if (source === undefined) return undefined
    const content = await source.driver.readSkill(source.location, candidate.name, this.control.signal)
    if (content === undefined) return undefined
    return {
      name: candidate.name, description: candidate.description, invocation: OPEN, source: source.source, provider: this.name,
      resourceBase: source.driver.skillResources(source.location, candidate.name), content,
    }
  }

  /**
   * The Skills a connector's CLI release ships, read once per CLI version.
   * @param source - the connector.
   * @returns the Skills, or none when the CLI cannot list them.
   */
  skills(source: SkillSource): Promise<readonly ConnectorSkill[]> {
    const key = `${source.source}@${source.version}`
    let listed = this.cache.get(key)
    if (listed === undefined) {
      listed = source.driver.listSkills(source.location, this.control.signal)
      this.cache.set(key, listed)
      // A failed listing is retried by the next lookup.
      void listed.then((skills) => { if (skills.length === 0) this.cache.delete(key) })
    }
    return listed
  }

  /** Tell the registry the connected connectors changed. */
  invalidate(): void { this.control.invalidate() }
}
