interface Browser {
  permissions: {
    request(input: { origins: string[] }): Promise<boolean>
    remove(input: { origins: string[] }): Promise<boolean>
    contains(input: { origins: string[] }): Promise<boolean>
  }
  runtime: {
    getManifest(): { version: string }
    openOptionsPage(): Promise<void>
    sendMessage(message: unknown): Promise<unknown>
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string; url?: string },
          respond: (response: unknown) => void,
        ) => boolean,
      ): void
    }
    getURL(path: string): string
  }
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(key: string): Promise<void>
    }
    onChanged: {
      addListener(listener: (changes: Record<string, unknown>, area: string) => void): void
    }
  }
  tabs: {
    query(query: { active: boolean; currentWindow: boolean }): Promise<{ url?: string }[]>
  }
}

const globals = globalThis as typeof globalThis & { browser?: Browser; chrome?: Browser }
export const browser = (globals.browser ?? globals.chrome)!
