/**
 * Credential resolution with priority: override → env.
 * Designed to be extended to a `~/.astorlm/auth.json` file in the future.
 */
export class AuthStorage {
  constructor(private readonly overrides: Record<string, string> = {}) {}

  get(key: string): string | undefined {
    return this.overrides[key] ?? process.env[key]
  }

  require(key: string): string {
    const v = this.get(key)
    if (!v) throw new Error(`Falta credencial: ${key}. Definila por env o pasala como override.`)
    return v
  }

  static default(): AuthStorage {
    return new AuthStorage()
  }
}
