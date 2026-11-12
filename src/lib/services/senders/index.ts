export {
  cancelSenderLogin,
  createSenderAccount,
  deleteSenderAccount,
  diagnoseSenderDm,
  disconnectSenderAccount,
  findConnectedSenderForDispatch,
  getSenderAccount,
  listSenderAccounts,
  resolveSenderForDispatch,
  startSenderConnect,
  connectSenderWithSessionId,
  toSenderAccountDto,
  verifySenderAccount,
  updateSenderSettings,
  pauseSenderAccount,
  resumeSenderAccount,
  type ConnectSenderResult,
  type SenderAccountDto,
  type SenderDispatchResolution,
  type SenderDmDiagnostics,
} from "./instagram-sender-service";


export {
  getSenderSessionManager,
  setSenderSessionDriver,
  SenderSessionManager,
  type ManagedSessionInfo,
  type SenderSessionCloseReason,
  type SenderSessionTimeouts,
} from "./sender-session-manager";

export {
  PLAYWRIGHT_CHROMIUM_INSTALL_HINT,
  SENDER_PROFILE_RECOVERY_HINT,
  SenderBrowserLaunchError,
  SenderBrowserMissingError,
  SenderProfileLaunchFailedError,
  isSenderBrowserMissingError,
  isSenderProfileLaunchFailedError,
} from "./sender-session-driver";

export type {
  BrowserAvailability,
  SenderAuthProbe,
  SenderBrowserSession,
  SenderNavigationResult,
  SenderSessionDiagnostics,
  SenderSessionDriver,
  SenderSessionMode,
} from "./sender-session-driver";

export { PlaywrightSenderSessionDriver } from "./playwright-session-driver";

export {
  buildSenderSessionPath,
  ensureSenderSessionDir,
  getInstagramSessionRootDir,
  removeSenderSessionDir,
  resolveSenderSessionDir,
  senderSessionDirExists,
  DEFAULT_INSTAGRAM_SESSION_DIR,
} from "./sender-session-paths";
