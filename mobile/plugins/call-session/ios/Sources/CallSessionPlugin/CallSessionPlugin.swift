import Foundation
import Capacitor

@objc(CallSessionPlugin)
public class CallSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CallSessionPlugin"
    public let jsName = "CallSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isCallActive", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        CallKitManager.shared.attach(plugin: self)
    }

    @objc func startCall(_ call: CAPPluginCall) {
        CallKitManager.shared.startOutboundCall()
        call.resolve()
    }

    @objc func endCall(_ call: CAPPluginCall) {
        CallKitManager.shared.endActiveCall()
        call.resolve()
    }

    @objc func isCallActive(_ call: CAPPluginCall) {
        call.resolve(["active": CallKitManager.shared.isCallActive()])
    }

    func notifyAudioSessionActivated() {
        notifyListeners("audioSessionActivated", data: [:])
    }

    func notifyAudioSessionDeactivated() {
        notifyListeners("audioSessionDeactivated", data: [:])
    }

    func notifyCallEnded() {
        notifyListeners("callEnded", data: [:])
    }

    func notifyIncomingCallAnswered() {
        notifyListeners("incomingCallAnswered", data: [:])
    }

    func notifyVoipToken(_ token: String) {
        notifyListeners("voipToken", data: ["token": token])
    }
}
