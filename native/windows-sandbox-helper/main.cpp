#define UNICODE
#define _UNICODE
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <numeric>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")

namespace fs = std::filesystem;

namespace {

struct Options {
    std::wstring workspace;
    std::wstring cwd;
    std::vector<std::wstring> readOnly;
    bool network = false;
    bool shell = false;
    std::vector<std::wstring> command;
};

struct AclGrant {
    std::wstring path;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL oldDacl = nullptr;
};

struct Profile {
    std::wstring name;
    PSID sid = nullptr;
    std::vector<PSID> capabilitySids;
};

void fail(const std::wstring& message) {
    std::wcerr << L"daedalus sandbox helper: " << message << std::endl;
    ExitProcess(2);
}

std::wstring errorText(DWORD code = GetLastError()) {
    wchar_t* buffer = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        code,
        0,
        reinterpret_cast<wchar_t*>(&buffer),
        0,
        nullptr
    );
    std::wstring result = length > 0 ? std::wstring(buffer, length) : L"unknown error";
    if (buffer != nullptr) LocalFree(buffer);
    while (!result.empty() && (result.back() == L'\r' || result.back() == L'\n' || result.back() == L' ')) result.pop_back();
    return result;
}

bool equalsInsensitive(const std::wstring& left, const std::wstring& right) {
    return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

std::wstring fullPath(const std::wstring& value) {
    wchar_t buffer[MAX_PATH];
    const DWORD length = GetFullPathNameW(value.c_str(), MAX_PATH, buffer, nullptr);
    if (length == 0 || length >= MAX_PATH) fail(L"path is missing or too long");
    return fs::path(buffer).lexically_normal().wstring();
}

bool isInside(const std::wstring& root, const std::wstring& candidate) {
    const std::wstring normalizedRoot = fullPath(root);
    const std::wstring normalizedCandidate = fullPath(candidate);
    if (equalsInsensitive(normalizedRoot, normalizedCandidate)) return true;
    if (normalizedCandidate.size() <= normalizedRoot.size()) return false;
    if (_wcsnicmp(normalizedRoot.c_str(), normalizedCandidate.c_str(), normalizedRoot.size()) != 0) return false;
    const wchar_t separator = normalizedCandidate[normalizedRoot.size()];
    return separator == L'\\' || separator == L'/';
}

bool isDirectory(const std::wstring& value) {
    const DWORD attributes = GetFileAttributesW(value.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool isRegularFile(const std::wstring& value) {
    const DWORD attributes = GetFileAttributesW(value.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

void requireAbsoluteExisting(const std::wstring& value, bool directory) {
    if (!fs::path(value).is_absolute()) fail(L"all sandbox paths must be absolute");
    if (directory ? !isDirectory(value) : !isRegularFile(value)) fail(L"sandbox path does not have the expected type");
}

std::wstring quoteArg(const std::wstring& value) {
    if (value.empty()) return L"\"\"";
    bool needsQuotes = false;
    for (const wchar_t character : value) {
        if (character == L' ' || character == L'\t' || character == L'\"') {
            needsQuotes = true;
            break;
        }
    }
    if (!needsQuotes) return value;
    std::wstring result = L"\"";
    unsigned backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
            continue;
        }
        if (character == L'\"') {
            result.append(backslashes * 2 + 1, L'\\');
            result.push_back(L'\"');
            backslashes = 0;
            continue;
        }
        result.append(backslashes, L'\\');
        backslashes = 0;
        result.push_back(character);
    }
    result.append(backslashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

std::wstring environmentValue(const wchar_t* name) {
    DWORD size = 256;
    std::vector<wchar_t> buffer(size);
    while (true) {
        const DWORD length = GetEnvironmentVariableW(name, buffer.data(), size);
        if (length == 0) return L"";
        if (length < size - 1) return std::wstring(buffer.data(), length);
        size = length + 1;
        buffer.resize(size);
    }
}

std::wstring resolveCommand(const std::wstring& command) {
    if (fs::path(command).is_absolute()) {
        requireAbsoluteExisting(command, false);
        return fullPath(command);
    }
    const std::wstring pathValue = environmentValue(L"Path").empty() ? environmentValue(L"PATH") : environmentValue(L"Path");
    std::vector<std::wstring> extensions;
    const std::wstring pathext = environmentValue(L"PATHEXT");
    size_t start = 0;
    while (start <= pathext.size()) {
        const size_t end = pathext.find(L';', start);
        const std::wstring extension = pathext.substr(start, end == std::wstring::npos ? end : end - start);
        if (!extension.empty()) extensions.push_back(extension);
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
    if (extensions.empty()) extensions = {L".COM", L".EXE", L".BAT", L".CMD"};
    start = 0;
    while (start <= pathValue.size()) {
        const size_t end = pathValue.find(L';', start);
        const std::wstring directory = pathValue.substr(start, end == std::wstring::npos ? end : end - start);
        if (!directory.empty()) {
            const fs::path base = fs::path(directory) / command;
            if (isRegularFile(base.wstring())) return fullPath(base.wstring());
            for (const std::wstring& extension : extensions) {
                const fs::path candidate = base.wstring().ends_with(extension) ? base : fs::path(base.wstring() + extension);
                if (isRegularFile(candidate.wstring())) return fullPath(candidate.wstring());
            }
        }
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
    fail(L"sandbox command was not found in the restricted PATH");
    return L"";
}

void parseArguments(int argc, wchar_t** argv, Options& options) {
    int index = 1;
    while (index < argc) {
        const std::wstring argument = argv[index];
        if (argument == L"--workspace" && index + 1 < argc) options.workspace = argv[++index];
        else if (argument == L"--cwd" && index + 1 < argc) options.cwd = argv[++index];
        else if (argument == L"--read-only" && index + 1 < argc) options.readOnly.push_back(argv[++index]);
        else if (argument == L"--network") options.network = true;
        else if (argument == L"--no-network") options.network = false;
        else if (argument == L"--argv") {
            options.shell = false;
            ++index;
            if (index < argc && std::wstring(argv[index]) == L"--") ++index;
            for (; index < argc; ++index) options.command.push_back(argv[index]);
            break;
        } else if (argument == L"--shell") {
            options.shell = true;
            ++index;
            if (index < argc && std::wstring(argv[index]) == L"--") ++index;
            for (; index < argc; ++index) options.command.push_back(argv[index]);
            break;
        } else {
            fail(L"unknown or incomplete helper argument");
        }
        ++index;
    }
    if (options.workspace.empty() || options.cwd.empty() || options.command.empty()) fail(L"workspace, cwd and command are required");
}

void grantAcl(const std::wstring& path, PSID sid, DWORD permissions, std::vector<AclGrant>& grants) {
    const std::wstring canonical = fullPath(path);
    if (std::any_of(grants.begin(), grants.end(), [&](const AclGrant& value) { return equalsInsensitive(value.path, canonical); })) return;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL oldDacl = nullptr;
    PSID owner = nullptr;
    PSID group = nullptr;
    if (GetNamedSecurityInfoW(canonical.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, &owner, &group, &oldDacl, nullptr, &descriptor) != ERROR_SUCCESS) {
        fail(L"cannot read ACL for " + canonical + L": " + errorText());
    }
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = permissions;
    access.grfAccessMode = GRANT_ACCESS;
    access.grfInheritance = isDirectory(canonical) ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);
    PACL newDacl = nullptr;
    if (SetEntriesInAclW(1, &access, oldDacl, &newDacl) != ERROR_SUCCESS) {
        if (descriptor != nullptr) LocalFree(descriptor);
        fail(L"cannot construct ACL for " + canonical + L": " + errorText());
    }
    if (SetNamedSecurityInfoW(const_cast<LPWSTR>(canonical.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, newDacl, nullptr) != ERROR_SUCCESS) {
        if (newDacl != nullptr) LocalFree(newDacl);
        if (descriptor != nullptr) LocalFree(descriptor);
        fail(L"cannot grant sandbox ACL for " + canonical + L": " + errorText());
    }
    if (newDacl != nullptr) LocalFree(newDacl);
    grants.push_back({canonical, descriptor, oldDacl});
}

bool isSystemPath(const std::wstring& value) {
    const std::wstring systemRoot = environmentValue(L"SystemRoot");
    return !systemRoot.empty() && isInside(systemRoot, value);
}

bool isProgramFilesPath(const std::wstring& value) {
    const std::wstring programFiles = environmentValue(L"ProgramFiles");
    const std::wstring programFilesX86 = environmentValue(L"ProgramFiles(x86)");
    const std::wstring programW6432 = environmentValue(L"ProgramW6432");
    return (!programFiles.empty() && isInside(programFiles, value))
        || (!programFilesX86.empty() && isInside(programFilesX86, value))
        || (!programW6432.empty() && isInside(programW6432, value));
}

std::wstring stageProtectedCommand(const std::wstring& command, std::wstring& stagingDirectory) {
    if (!isProgramFilesPath(command)) return command;

    wchar_t temporaryPath[MAX_PATH];
    const DWORD length = GetTempPathW(MAX_PATH, temporaryPath);
    if (length == 0 || length >= MAX_PATH) fail(L"cannot resolve the temporary directory for the sandbox runtime");
    const fs::path temporaryRoot(temporaryPath);
    for (unsigned int attempt = 0; attempt < 32; ++attempt) {
        const fs::path candidate = temporaryRoot
            / (L"DaedalusSandbox." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(GetTickCount64()) + L"." + std::to_wstring(attempt));
        if (CreateDirectoryW(candidate.c_str(), nullptr) == FALSE) {
            if (GetLastError() == ERROR_ALREADY_EXISTS) continue;
            fail(L"cannot create the temporary directory for the sandbox runtime: " + errorText());
        }
        const fs::path stagedCommand = candidate / fs::path(command).filename();
        if (CopyFileW(command.c_str(), stagedCommand.c_str(), TRUE) == FALSE) {
            std::error_code error;
            fs::remove_all(candidate, error);
            fail(L"cannot stage the protected sandbox runtime: " + errorText());
        }
        stagingDirectory = candidate.wstring();
        return stagedCommand.wstring();
    }
    fail(L"cannot allocate a unique temporary directory for the sandbox runtime");
    return L"";
}

void cleanupStagedCommand(const std::wstring& stagingDirectory) {
    if (stagingDirectory.empty()) return;
    std::error_code error;
    fs::remove_all(stagingDirectory, error);
}

void restoreAcls(std::vector<AclGrant>& grants) {
    for (auto iterator = grants.rbegin(); iterator != grants.rend(); ++iterator) {
        SetNamedSecurityInfoW(const_cast<LPWSTR>(iterator->path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, iterator->oldDacl, nullptr);
        if (iterator->descriptor != nullptr) LocalFree(iterator->descriptor);
    }
    grants.clear();
}

Profile createProfile(bool network) {
    Profile profile;
    profile.name = L"DaedalusSandbox." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(GetTickCount64());
    std::vector<SID_AND_ATTRIBUTES> capabilities;
    if (network) {
        PSID* capabilityGroupSids = nullptr;
        PSID* capabilitySids = nullptr;
        DWORD capabilityGroupCount = 0;
        DWORD capabilityCount = 0;
        if (!DeriveCapabilitySidsFromName(L"internetClient", &capabilityGroupSids, &capabilityGroupCount, &capabilitySids, &capabilityCount) || capabilityCount == 0) {
            fail(L"cannot derive the Windows internet capability");
        }
        profile.capabilitySids.assign(capabilitySids, capabilitySids + capabilityCount);
        capabilities.resize(capabilityCount);
        for (DWORD index = 0; index < capabilityCount; ++index) capabilities[index] = {profile.capabilitySids[index], SE_GROUP_ENABLED};
        for (DWORD index = 0; index < capabilityGroupCount; ++index) if (capabilityGroupSids[index] != nullptr) LocalFree(capabilityGroupSids[index]);
        if (capabilityGroupSids != nullptr) LocalFree(capabilityGroupSids);
        if (capabilitySids != nullptr) LocalFree(capabilitySids);
    }
    DeleteAppContainerProfile(profile.name.c_str());
    const HRESULT profileResult = CreateAppContainerProfile(profile.name.c_str(), L"Daedalus Plugin Sandbox", L"Daedalus restricted plugin process", capabilities.empty() ? nullptr : capabilities.data(), static_cast<DWORD>(capabilities.size()), &profile.sid);
    if (FAILED(profileResult) && profileResult != HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        fail(L"cannot create AppContainer profile (HRESULT 0x" + [&]() { wchar_t buffer[16]; swprintf_s(buffer, L"%08lx", static_cast<unsigned long>(profileResult)); return std::wstring(buffer); }() + L")");
    }
    if (profile.sid == nullptr) {
        const HRESULT sidResult = DeriveAppContainerSidFromAppContainerName(profile.name.c_str(), &profile.sid);
        if (FAILED(sidResult) || profile.sid == nullptr) {
            fail(L"cannot derive AppContainer SID (HRESULT 0x" + [&]() { wchar_t buffer[16]; swprintf_s(buffer, L"%08lx", static_cast<unsigned long>(sidResult)); return std::wstring(buffer); }() + L")");
        }
    }
    return profile;
}

void deleteProfile(Profile& profile) {
    if (!profile.name.empty()) DeleteAppContainerProfile(profile.name.c_str());
    if (profile.sid != nullptr) FreeSid(profile.sid);
    for (PSID sid : profile.capabilitySids) if (sid != nullptr) LocalFree(sid);
    profile.sid = nullptr;
    profile.capabilitySids.clear();
}

std::wstring buildCommandLine(const Options& options, const std::wstring& resolvedCommand) {
    if (options.shell) {
        const std::wstring commandLine = std::accumulate(options.command.begin(), options.command.end(), std::wstring(), [](std::wstring result, const std::wstring& value) {
            if (!result.empty()) result.push_back(L' ');
            return result + value;
        });
        const std::wstring comSpec = environmentValue(L"ComSpec").empty() ? L"C:\\Windows\\System32\\cmd.exe" : environmentValue(L"ComSpec");
        return quoteArg(comSpec) + L" /d /s /c " + quoteArg(commandLine);
    }
    std::wstring result = quoteArg(resolvedCommand);
    for (size_t index = 1; index < options.command.size(); ++index) result += L" " + quoteArg(options.command[index]);
    if (resolvedCommand.ends_with(L".cmd") || resolvedCommand.ends_with(L".bat") || resolvedCommand.ends_with(L".CMD") || resolvedCommand.ends_with(L".BAT")) {
        const std::wstring comSpec = environmentValue(L"ComSpec").empty() ? L"C:\\Windows\\System32\\cmd.exe" : environmentValue(L"ComSpec");
        return quoteArg(comSpec) + L" /d /s /c call " + result;
    }
    return result;
}

DWORD runInAppContainer(const Options& options, Profile& profile, std::vector<AclGrant>& grants) {
    const std::wstring originalCommand = resolveCommand(options.command.front());
    std::wstring stagingDirectory;
    const std::wstring resolvedCommand = stageProtectedCommand(originalCommand, stagingDirectory);
    // CreateProcessAsUser requires the current-drive entry when it receives a
    // deliberately reduced environment block. Node's child_process environment
    // object does not preserve these `=C:` entries, so restore the one used by
    // the sandbox cwd before launching the AppContainer process.
    const std::wstring driveName = L"=" + fs::path(options.cwd).root_name().wstring();
    if (driveName != L"=") SetEnvironmentVariableW(driveName.c_str(), options.cwd.c_str());
    if (!isSystemPath(resolvedCommand)) {
        grantAcl(resolvedCommand, profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, grants);
        grantAcl(fs::path(resolvedCommand).parent_path().wstring(), profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, grants);
    }
    if (options.shell) {
        const std::wstring comSpec = environmentValue(L"ComSpec").empty() ? L"C:\\Windows\\System32\\cmd.exe" : environmentValue(L"ComSpec");
        if (!isSystemPath(comSpec)) {
            grantAcl(comSpec, profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, grants);
            grantAcl(fs::path(comSpec).parent_path().wstring(), profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, grants);
        }
    }
    grantAcl(options.workspace, profile.sid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE, grants);
    for (const std::wstring& path : options.readOnly) grantAcl(path, profile.sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, grants);

    // Do not pass the caller's anonymous pipes directly into the AppContainer:
    // Node creates them with an ACL that does not include the lowbox SID.  A
    // broker-owned pipe with an explicit AppContainer DACL keeps the JSON-line
    // protocol working for both console and child_process stdio.
    LPWSTR sidText = nullptr;
    if (!ConvertSidToStringSidW(profile.sid, &sidText)) fail(L"cannot convert sandbox SID for standard pipes: " + errorText());
    // Keep the creating helper as owner while granting the lowbox SID access
    // to the broker-owned pipe endpoints.
    const std::wstring pipeSddl = L"D:(A;;GA;;;OW)(A;;GA;;;" + std::wstring(sidText) + L")";
    LocalFree(sidText);
    PSECURITY_DESCRIPTOR pipeDescriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(pipeSddl.c_str(), SDDL_REVISION_1, &pipeDescriptor, nullptr)) {
        fail(L"cannot create security descriptor for standard pipes: " + errorText());
    }
    SECURITY_ATTRIBUTES pipeAttributes{};
    pipeAttributes.nLength = sizeof(pipeAttributes);
    pipeAttributes.lpSecurityDescriptor = pipeDescriptor;
    pipeAttributes.bInheritHandle = TRUE;
    HANDLE helperStdinWrite = nullptr;
    HANDLE childStdinRead = nullptr;
    HANDLE helperStdoutRead = nullptr;
    HANDLE childStdoutWrite = nullptr;
    HANDLE helperStderrRead = nullptr;
    HANDLE childStderrWrite = nullptr;
    if (CreatePipe(&childStdinRead, &helperStdinWrite, &pipeAttributes, 0) != TRUE
        || CreatePipe(&helperStdoutRead, &childStdoutWrite, &pipeAttributes, 0) != TRUE
        || CreatePipe(&helperStderrRead, &childStderrWrite, &pipeAttributes, 0) != TRUE) {
        const DWORD pipeError = GetLastError();
        if (pipeDescriptor != nullptr) LocalFree(pipeDescriptor);
        fail(L"cannot create standard pipes (error " + std::to_wstring(pipeError) + L"): " + errorText(pipeError));
    }
    LocalFree(pipeDescriptor);
    SetHandleInformation(helperStdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(helperStdoutRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(helperStderrRead, HANDLE_FLAG_INHERIT, 0);
    const std::vector<HANDLE> inheritedHandles = {childStdinRead, childStdoutWrite, childStderrWrite};

    SIZE_T attributeSize = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeSize);
    auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, attributeSize));
    if (attributes == nullptr || InitializeProcThreadAttributeList(attributes, 2, 0, &attributeSize) != TRUE) fail(L"cannot initialize process security attributes");
    SECURITY_CAPABILITIES securityCapabilities{};
    securityCapabilities.AppContainerSid = profile.sid;
    if (UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &securityCapabilities, sizeof(securityCapabilities), nullptr, nullptr) != TRUE) fail(L"cannot configure AppContainer process attributes");
    if (!inheritedHandles.empty() && UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, const_cast<HANDLE*>(inheritedHandles.data()), inheritedHandles.size() * sizeof(HANDLE), nullptr, nullptr) != TRUE) {
        fail(L"cannot configure inherited standard handles");
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = childStdinRead;
    startup.StartupInfo.hStdOutput = childStdoutWrite;
    startup.StartupInfo.hStdError = childStderrWrite;
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION processInfo{};
    std::wstring commandLine = buildCommandLine(options, resolvedCommand);
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');
    const BOOL created = CreateProcessAsUserW(nullptr, nullptr, mutableCommand.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, nullptr, options.cwd.c_str(), &startup.StartupInfo, &processInfo);
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    if (!created) {
        const DWORD createError = GetLastError();
        CloseHandle(childStdinRead);
        CloseHandle(helperStdinWrite);
        CloseHandle(helperStdoutRead);
        CloseHandle(childStdoutWrite);
        CloseHandle(helperStderrRead);
        CloseHandle(childStderrWrite);
        cleanupStagedCommand(stagingDirectory);
        fail(L"cannot start the sandboxed process (error " + std::to_wstring(createError) + L"): " + errorText(createError));
    }
    CloseHandle(childStdinRead);
    CloseHandle(childStdoutWrite);
    CloseHandle(childStderrWrite);

    const HANDLE outerStdin = GetStdHandle(STD_INPUT_HANDLE);
    const HANDLE outerStdout = GetStdHandle(STD_OUTPUT_HANDLE);
    const HANDLE outerStderr = GetStdHandle(STD_ERROR_HANDLE);
    auto pump = [](HANDLE source, HANDLE destination) -> void {
        if (source == nullptr || source == INVALID_HANDLE_VALUE || destination == nullptr || destination == INVALID_HANDLE_VALUE) return;
        char buffer[8192];
        DWORD bytesRead = 0;
        while (ReadFile(source, buffer, sizeof(buffer), &bytesRead, nullptr) == TRUE && bytesRead > 0) {
            DWORD offset = 0;
            while (offset < bytesRead) {
                DWORD bytesWritten = 0;
                if (WriteFile(destination, buffer + offset, bytesRead - offset, &bytesWritten, nullptr) != TRUE || bytesWritten == 0) return;
                offset += bytesWritten;
            }
        }
    };
    std::thread stdinPump([pump, outerStdin, helperStdinWrite]() {
        pump(outerStdin, helperStdinWrite);
        CloseHandle(helperStdinWrite);
    });
    stdinPump.detach();
    std::thread stdoutPump([pump, helperStdoutRead, outerStdout]() { pump(helperStdoutRead, outerStdout); });
    std::thread stderrPump([pump, helperStderrRead, outerStderr]() { pump(helperStderrRead, outerStderr); });
    CloseHandle(processInfo.hThread);
    WaitForSingleObject(processInfo.hProcess, INFINITE);
    DWORD exitCode = 1;
    GetExitCodeProcess(processInfo.hProcess, &exitCode);
    CloseHandle(processInfo.hProcess);
    stdoutPump.join();
    stderrPump.join();
    CloseHandle(helperStdoutRead);
    CloseHandle(helperStderrRead);
    cleanupStagedCommand(stagingDirectory);
    return exitCode;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    Options options;
    parseArguments(argc, argv, options);
    DWORD lowBoxConsoleEnabled = 1;
    RegSetKeyValueW(HKEY_CURRENT_USER, L"Console", L"LowBoxConsoleEnabled", REG_DWORD, &lowBoxConsoleEnabled, sizeof(lowBoxConsoleEnabled));
    options.workspace = fullPath(options.workspace);
    options.cwd = fullPath(options.cwd);
    requireAbsoluteExisting(options.workspace, true);
    requireAbsoluteExisting(options.cwd, true);
    if (!isInside(options.workspace, options.cwd)) fail(L"cwd must remain inside workspace");
    for (const std::wstring& path : options.readOnly) {
        requireAbsoluteExisting(path, isDirectory(path));
    }
    Profile profile = createProfile(options.network);
    std::vector<AclGrant> grants;
    DWORD exitCode = 1;
    try {
        exitCode = runInAppContainer(options, profile, grants);
    } catch (...) {
        restoreAcls(grants);
        deleteProfile(profile);
        throw;
    }
    restoreAcls(grants);
    deleteProfile(profile);
    return static_cast<int>(exitCode);
}
