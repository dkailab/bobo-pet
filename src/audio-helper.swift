// 卜卜宠物 · 音频节拍助手
// 用 ScreenCaptureKit 采集系统音频（macOS 13+），计算 RMS 能量与节拍，
// 通过 stdout 输出：E <0~1 能量> / B（节拍）/ S 状态
// 编译：swiftc -O -o audio-helper audio-helper.swift -framework ScreenCaptureKit
import Foundation
import ScreenCaptureKit
import CoreMedia
import AudioToolbox
import CoreGraphics

final class Capture: NSObject, SCStreamOutput {
  private var stream: SCStream?
  private let queue = DispatchQueue(label: "bobo.audio")
  private var lastBeat = Date(timeIntervalSince1970: 0)
  private var lastEmit = Date(timeIntervalSince1970: 0)
  private var smoothed: Float = 0

  private func out(_ s: String) {
    let d = (s + "\n").data(using: .utf8)!
    FileHandle.standardOutput.write(d)
  }

  func start() async {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first else {
        FileHandle.standardError.write("ERR no display\n".data(using: .utf8)!)
        return
      }
      let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
      let config = SCStreamConfiguration()
      config.capturesAudio = true
      config.excludesCurrentProcessAudio = true
      config.sampleRate = 48000
      config.channelCount = 2
      config.width = 2
      config.height = 2
      let s = SCStream(filter: filter, configuration: config, delegate: nil)
      try s.addStreamOutput(self, type: SCStreamOutputType.audio, sampleHandlerQueue: queue)
      try await s.startCapture()
      stream = s
      out("S ready")
    } catch {
      FileHandle.standardError.write("ERR \(error)\n".data(using: .utf8)!)
    }
  }

  private func computeRMS(_ sampleBuffer: CMSampleBuffer) -> Float {
    var size = 0
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: &size,
      bufferListOut: nil,
      bufferListSize: 0,
      blockBufferAllocator: nil,
      blockBufferMemoryAllocator: nil,
      flags: 0,
      blockBufferOut: nil
    )
    guard status == kCMBlockBufferNoErr, size > 0 else { return 0 }

    var abl = AudioBufferList()
    var blockBuffer: CMBlockBuffer?
    var ok = false
    withUnsafeMutablePointer(to: &abl) { ptr in
      let st = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: ptr,
        bufferListSize: size,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: 0,
        blockBufferOut: &blockBuffer
      )
      ok = st == kCMBlockBufferNoErr
    }
    guard ok else { return 0 }

    // 判断是 16 位整型还是 Float32
    var isFloat = false
    if let desc = CMSampleBufferGetFormatDescription(sampleBuffer) {
      if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc) {
        isFloat = asbd.pointee.mFormatFlags & kAudioFormatFlagIsFloat != 0
      }
    }

    var sum: Double = 0
    var count: Int = 0
    let bufferList = UnsafeMutableAudioBufferListPointer(&abl)
    for buf in bufferList {
      let n = Int(buf.mDataByteSize)
      guard n > 0, let data = buf.mData else { continue }
      if isFloat {
        let p = data.assumingMemoryBound(to: Float.self)
        let c = n / MemoryLayout<Float>.size
        for j in 0..<c {
          let v = Double(p[j])
          sum += v * v
        }
        count += c
      } else {
        let p = data.assumingMemoryBound(to: Int16.self)
        let c = n / MemoryLayout<Int16>.size
        for j in 0..<c {
          let v = Double(p[j]) / 32768.0
          sum += v * v
        }
        count += c
      }
    }
    guard count > 0 else { return 0 }
    return Float(sqrt(sum / Double(count)))
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio else { return }
    let rms = computeRMS(sampleBuffer)
    smoothed = 0.7 * smoothed + 0.3 * rms

    let now = Date()
    // 节拍：短时能量跃升
    let onset = max(0, rms - smoothed)
    if onset > 0.05 && rms > 0.02 && now.timeIntervalSince(lastBeat) > 0.22 {
      lastBeat = now
      out("B")
    }
    // 能量输出节流：~20Hz
    if now.timeIntervalSince(lastEmit) > 0.05 {
      lastEmit = now
      out(String(format: "E %.3f", rms))
    }
  }
}

let capture = Capture()
Task { await capture.start() }
dispatchMain()