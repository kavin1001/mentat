import type { MentatBridge } from '../../preload/index'
declare global {
  interface Window {
    mentat: MentatBridge
  }
}
export {}
