export class InjectedCrash extends Error {
  constructor(boundary: string) {
    super(`injected crash: ${boundary}`);
    this.name = "InjectedCrash";
  }
}

export function isInjectedCrash(error: unknown): error is InjectedCrash {
  return error instanceof InjectedCrash;
}
