import { randomUUID } from 'node:crypto'

export interface TempRecordingResource {
  id: string
  filePath: string
  createdAt: number
}

export class TempRecordingStore {
  private readonly resources = new Map<string, TempRecordingResource>()

  register(filePath: string): TempRecordingResource {
    const resource: TempRecordingResource = {
      id: `recording-${randomUUID()}`,
      filePath,
      createdAt: Date.now()
    }
    this.resources.set(resource.id, resource)
    return resource
  }

  get(id: string): TempRecordingResource | null {
    return this.resources.get(id) ?? null
  }

  resolvePath(id: string): string | null {
    return this.get(id)?.filePath ?? null
  }

  release(id: string): TempRecordingResource | null {
    const resource = this.get(id)
    if (!resource) return null
    this.resources.delete(id)
    return resource
  }

  forgetByPath(filePath: string): void {
    for (const [id, resource] of this.resources.entries()) {
      if (resource.filePath === filePath) {
        this.resources.delete(id)
      }
    }
  }
}
