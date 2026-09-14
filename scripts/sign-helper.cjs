// 卜卜宠物 · 打包后脚本
// 作用：把 asar 解包出来的独立音频助手 audio-helper 用与主 App 相同的签名身份签名。
//
// 背景：audio-helper 用 ScreenCaptureKit 采集系统音频（属于"屏幕与系统音频录制"权限）。
// macOS 的 TCC 权限按【进程的签名 Identifier】记录。此前 audio-helper 每次编译得到的
// Identifier 不同（audio-helper-<随机>），导致身份一直在变，系统把它当"陌生应用"，
// 于是用户明明授权了仍反复弹窗。
//
// 修复：用 --identifier 把它的签名标识指定为主 App 的 Bundle ID（com.bubupet.desktop），
// 使其与主 App 归为同一签名身份，TCC 权限即可稳定命中。adhoc 签名下该值也有效。
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const APP_BUNDLE_ID = 'com.bubupet.desktop'

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const productName = packager.appInfo.productName || '卜卜宠物'

  const appPath = path.join(appOutDir, `${productName}.app`)
  const helperPath = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'audio-helper')

  if (!fs.existsSync(helperPath)) {
    console.log('[sign-helper] audio-helper not found, skip')
    return
  }

  try {
    // 关键：把独立 helper 的签名 Identifier 强制归一到主 App Bundle ID。
    // 使系统把它与主 App 视为同一签名身份，录屏权限可被稳定记住。
    console.log('[sign-helper] codesign audio-helper identifier=', APP_BUNDLE_ID)
    execFileSync(
      'codesign',
      ['--force', '--sign', '-', '--identifier', APP_BUNDLE_ID, '--strict', helperPath],
      { stdio: 'inherit' }
    )
    // 重签 helper 后，外层 App 的 seal 与 helper 签名已不一致，需对整包做一次
    // --deep 重签刷新资源密封（保留各组件已有 Identifier），使最终产物通过完整性验证。
    console.log('[sign-helper] re-seal full app (deep adhoc)')
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--strict', appPath],
      { stdio: 'inherit' }
    )
    // 最终校验
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
    console.log('[sign-helper] verify OK')
  } catch (e) {
    console.warn('[sign-helper] 签名/校验失败（不影响产物生成）：', String(e.message || e))
  }
}