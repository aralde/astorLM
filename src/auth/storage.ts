/**
 * Resolución de credenciales con prioridad: override → env.
 * Diseñado para extenderse a archivo `~/.astorlm/auth.json` en el futuro.
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
