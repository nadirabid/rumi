/** Scope a fresh thin Mach-O 64-bit executable's build UUID; the result must be signed. */
export function scopeExecutableUuid(image: Buffer, bundleId: string): Buffer
/** Rewrite freshly copied Rumi and helper executable UUIDs before code signing. */
export function scopeMacOSExecutableIdentities(appPath: string, executableName: string, bundleId: string): Promise<void>
