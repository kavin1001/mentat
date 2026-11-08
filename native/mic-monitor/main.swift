// mic-monitor: prints a JSON array of the apps using the microphone, one line each time it changes.
// Mentat runs it on macOS to notice calls (Zoom, Meet, Teams…). It only reads which processes have audio
// input running; it never opens the microphone itself, so it needs no permission.
// Usage: mic-monitor [--once]
import CoreAudio
import Foundation
import AppKit

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var addr = address(selector)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

@available(macOS 14.0, *)
func processesUsingInput() -> [String] {
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  var out: [String] = []
  for id in ids where readUInt32(id, kAudioProcessPropertyIsRunningInput) == 1 {
    var bundleAddr = address(kAudioProcessPropertyBundleID)
    var cfSize = UInt32(MemoryLayout<CFString?>.size)
    var bundle: Unmanaged<CFString>?
    var name = ""
    if AudioObjectGetPropertyData(id, &bundleAddr, 0, nil, &cfSize, &bundle) == noErr, let b = bundle?.takeRetainedValue() {
      name = b as String
    }
    if name.isEmpty, let pid = readUInt32(id, kAudioProcessPropertyPID) {
      let app = NSRunningApplication(processIdentifier: pid_t(bitPattern: pid))
      name = app?.bundleIdentifier ?? app?.executableURL?.lastPathComponent ?? "pid:\(pid)"
    }
    out.append(name)
  }
  return out
}

/// macOS 13 has no per-process list: report "*" while the default input device is busy.
func defaultInputBusy() -> Bool {
  var addr = address(kAudioHardwarePropertyDefaultInputDevice)
  var device = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device) == noErr else { return false }
  return readUInt32(device, kAudioDevicePropertyDeviceIsRunningSomewhere) == 1
}

func snapshot() -> [String] {
  if #available(macOS 14.0, *) { return Array(Set(processesUsingInput())).sorted() }
  return defaultInputBusy() ? ["*"] : []
}

func emit(_ list: [String]) {
  let data = try! JSONSerialization.data(withJSONObject: list)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

setvbuf(stdout, nil, _IOLBF, 0)
if CommandLine.arguments.contains("--once") {
  emit(snapshot())
  exit(0)
}
var last: [String]? = nil
while true {
  let now = snapshot()
  if now != last {
    emit(now)
    last = now
  }
  // Exit when Mentat goes away (stdin closes).
  if getppid() == 1 { exit(0) }
  Thread.sleep(forTimeInterval: 1.0)
}
