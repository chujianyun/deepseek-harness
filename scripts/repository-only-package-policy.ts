/**
 * Packages under `packages/` that are built and used only from this repository and never published to
 * npm. They are no release member: they stay private, the dsh package-entry rules do not apply, and
 * publint does not lint a publication view they never have.
 */
export const REPOSITORY_ONLY_PACKAGE_DIRECTORIES: readonly string[] = [
  // Builds the Skill Hub upload packages from its own `src/` and `skills/`; tenants receive those zips, not this package.
  'packages/ecommerce/tmall-skills',
]

/**
 * Whether a package directory is built and used only from this repository.
 * @param directory - repository-relative package directory.
 * @param repositoryOnly - the directories excluded from publication.
 * @returns Whether the package never publishes.
 */
export function isRepositoryOnlyPackageDirectory(
  directory: string,
  repositoryOnly: readonly string[] = REPOSITORY_ONLY_PACKAGE_DIRECTORIES,
): boolean {
  return repositoryOnly.includes(directory)
}
