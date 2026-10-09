/**
 * The current process's access token and the user it names, kept apart from token.ts so the ACL
 * editing in acl.ts can read the user without importing the restricted-token construction.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/process-token
 */

import { allocBytes, allocPtrSlot, allocUint32, decodePtr, decodePtrAt, decodeUint32, isNullPtr, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Open the current process's access token with the rights
 * CreateRestrictedToken requires (the POC's OpenProcessToken call; the token
 * handle is obtained through a real OpenProcess handle because the
 * GetCurrentProcess() pseudo-handle is not addressable through koffi).
 * @param api - the binding table.
 * @returns the opened token handle.
 */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`)

  const tokenSlot = allocPtrSlot()
  const opened = api.openProcessToken(
    processHandle,
    abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  )
  if (opened === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(processHandle) // best-effort on the error path
    throwWin32(api, 'OpenProcessToken', win32Code, `pid ${process.pid}`)
  }
  if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'OpenProcess process handle')
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle')
  return token
}

/**
 * Copy the SID of the user the current process runs as (TokenUser).
 * @param api - the binding table.
 * @returns a copied SID; the caller frees it with LocalFree.
 */
export function currentUserSid(api: Win32Bindings): NativePtr {
  const token = openCurrentProcessToken(api)
  try {
    const neededSlot = allocUint32()
    api.getTokenInformation(token, abi.TokenUser, null, 0, neededSlot) // expected to fail with ERROR_INSUFFICIENT_BUFFER
    const needed = decodeUint32(neededSlot)
    if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenUser size query')
    const user = Buffer.alloc(needed)
    if (api.getTokenInformation(token, abi.TokenUser, user, user.length, neededSlot) === 0) {
      throwLastError(api, 'GetTokenInformation', 'TokenUser')
    }
    const sidPtr = decodePtrAt(user, 0)
    if (sidPtr === null) throwWin32(api, 'GetTokenInformation', api.getLastError(), 'TokenUser carries no SID')
    const sidLength = api.getLengthSid(sidPtr)
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', 'TokenUser SID')
    const copy = allocBytes(sidLength)
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, 'CopySid', 'TokenUser SID')
    return copy
  } finally {
    api.closeHandle(token)
  }
}
