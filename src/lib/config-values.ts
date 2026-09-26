export function resolveSecretOverride(value: string | undefined, fallback: string): string {
    if (value === undefined || value.startsWith('••••')) return fallback;
    return value;
}
