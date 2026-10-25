import { desktopCapturer, screen, nativeImage } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

export interface Screenshot {
  id: string
  timestamp: number
  filePath: string
  previewPath: string
  width: number
  height: number
}

export interface ScreenshotConfig {
  maxCount: number
  previewWidth: number
  previewHeight: number
  storageDir: string
}

export class ScreenshotHelper {
  private screenshots: Screenshot[] = []
  private config: ScreenshotConfig
  private captureInProgress = false

  constructor(config?: Partial<ScreenshotConfig>) {
    this.config = {
      maxCount: config?.maxCount ?? 10,
      previewWidth: config?.previewWidth ?? 200,
      previewHeight: config?.previewHeight ?? 150,
      storageDir: config?.storageDir ?? path.join(os.tmpdir(), 'notto-screenshots')
    }
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.config.storageDir, { recursive: true })
      // Clean up any old screenshots on startup
      await this.cleanupOldScreenshots()
    } catch (err) {
      console.error('Failed to initialize screenshot storage:', err)
    }
  }

  async captureScreenshot(): Promise<Screenshot | null> {
    if (this.captureInProgress) {
      console.warn('Screenshot capture already in progress')
      return null
    }

    this.captureInProgress = true

    try {
      const primaryDisplay = screen.getPrimaryDisplay()
      const { width, height } = primaryDisplay.size

      // Use desktopCapturer to get screenshot
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      })

      if (sources.length === 0) {
        console.error('No screen sources available for capture')
        return null
      }

      // Get the primary screen (first source is usually the primary display)
      const primarySource = sources[0]
      const thumbnail = primarySource.thumbnail

      // Generate unique ID and paths
      const id = `screenshot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const timestamp = Date.now()
      const filePath = path.join(this.config.storageDir, `${id}.png`)
      const previewPath = path.join(this.config.storageDir, `${id}-preview.png`)

      // Save full screenshot
      const pngBuffer = thumbnail.toPNG()
      await fs.writeFile(filePath, pngBuffer)

      // Generate and save preview
      const aspectRatio = width / height
      const previewHeight = Math.round(this.config.previewWidth / aspectRatio)
      const resized = thumbnail.resize({
        width: this.config.previewWidth,
        height: previewHeight,
        quality: 'good'
      })
      const previewBuffer = resized.toPNG()
      await fs.writeFile(previewPath, previewBuffer)

      const screenshot: Screenshot = {
        id,
        timestamp,
        filePath,
        previewPath,
        width,
        height
      }

      // Add to queue (ring buffer behavior)
      this.screenshots.push(screenshot)
      if (this.screenshots.length > this.config.maxCount) {
        const removed = this.screenshots.shift()
        if (removed) {
          await this.deleteScreenshotFiles(removed)
        }
      }

      return screenshot
    } catch (err) {
      console.error('Failed to capture screenshot:', err)
      return null
    } finally {
      this.captureInProgress = false
    }
  }

  async deleteScreenshot(id: string): Promise<boolean> {
    try {
      const index = this.screenshots.findIndex(s => s.id === id)
      if (index === -1) {
        return false
      }

      const screenshot = this.screenshots[index]
      this.screenshots.splice(index, 1)
      await this.deleteScreenshotFiles(screenshot)
      return true
    } catch (err) {
      console.error('Failed to delete screenshot:', err)
      return false
    }
  }

  private async deleteScreenshotFiles(screenshot: Screenshot): Promise<void> {
    try {
      await fs.unlink(screenshot.filePath).catch(() => {})
      await fs.unlink(screenshot.previewPath).catch(() => {})
    } catch {
      // Ignore errors during cleanup
    }
  }

  async clearAllScreenshots(): Promise<void> {
    const screenshots = [...this.screenshots]
    this.screenshots = []
    
    for (const screenshot of screenshots) {
      await this.deleteScreenshotFiles(screenshot)
    }
  }

  getScreenshots(): Screenshot[] {
    return [...this.screenshots]
  }

  getScreenshot(id: string): Screenshot | null {
    return this.screenshots.find(s => s.id === id) ?? null
  }

  async getScreenshotData(id: string): Promise<Buffer | null> {
    try {
      const screenshot = this.getScreenshot(id)
      if (!screenshot) {
        return null
      }
      return await fs.readFile(screenshot.filePath)
    } catch (err) {
      console.error('Failed to read screenshot data:', err)
      return null
    }
  }

  async getScreenshotBase64(id: string): Promise<string | null> {
    try {
      const data = await this.getScreenshotData(id)
      if (!data) {
        return null
      }
      return data.toString('base64')
    } catch (err) {
      console.error('Failed to get screenshot base64:', err)
      return null
    }
  }

  private async cleanupOldScreenshots(): Promise<void> {
    // Don't delete screenshots on startup - they are persisted for chat history
    // Cleanup is handled by the ring buffer mechanism when new screenshots are captured
    return
  }

  getConfig(): ScreenshotConfig {
    return { ...this.config }
  }

  updateConfig(config: Partial<ScreenshotConfig>): void {
    this.config = { ...this.config, ...config }
    
    // If maxCount was reduced, trim excess screenshots
    if (config.maxCount !== undefined && this.screenshots.length > config.maxCount) {
      const toRemove = this.screenshots.splice(0, this.screenshots.length - config.maxCount)
      toRemove.forEach(screenshot => this.deleteScreenshotFiles(screenshot))
    }
  }
}

export const screenshotHelper = new ScreenshotHelper()
