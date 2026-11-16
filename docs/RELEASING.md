# Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when you push a tag like `v1.2.3`. The workflow:

1. derives the version from the tag (`v1.2.3` becomes `1.2.3`) and stamps it into the extension manifest (in a temp copy, never committed), `MARKETING_VERSION` (`CFBundleShortVersionString`) and `CURRENT_PROJECT_VERSION` (`CFBundleVersion`, set to the workflow run number);
2. imports your Developer ID certificate into a temporary keychain, which is deleted at the end of the job;
3. archives the app with Developer ID signing, the hardened runtime and a secure timestamp (`scripts/release.sh`, which calls `SIGN_MODE=developer-id ./build.sh`);
4. verifies the signature and entitlements, notarizes with `notarytool`, staples the ticket and runs a Gatekeeper check;
5. zips the app (`Send-to-Claude-1.2.3.zip`), writes a SHA-256 checksum and attaches both to a GitHub Release with auto-generated notes.

The minimum macOS for release builds is 12.0 (override with `MACOS_DEPLOYMENT_TARGET`).

Nothing is signed unless the secrets below exist. If any are missing, the workflow stops at the first step with a list of what's missing.

## One-time setup

You need a paid Apple Developer Program membership. Creating a Developer ID certificate requires the **Account Holder** role, which is you on an individual account.

### 1. Create a Developer ID Application certificate

**In Xcode (easiest):**

1. Xcode > Settings > Accounts. Add your Apple ID if it's not listed.
2. Select your team, then click **Manage Certificates…**.
3. Click **+** at the bottom left and choose **Developer ID Application**.

Xcode creates the private key in your login keychain and installs the certificate.

**Or on developer.apple.com:**

1. Open Keychain Access > Keychain Access menu > Certificate Assistant > **Request a Certificate From a Certificate Authority…**. Enter your email, choose **Saved to disk**, and save the `.certSigningRequest` file.
2. Go to <https://developer.apple.com/account/resources/certificates/add>, choose **Developer ID Application** (use the G2 Sub-CA if you're asked), and upload the CSR.
3. Download the `.cer` and double-click it to install it into your login keychain.

Check that it's there:

```sh
security find-identity -v -p codesigning
# 1) ABC123… "Developer ID Application: Your Name (ABCDE12345)"
```

The 10 characters in parentheses are your **Team ID**. You can also find it at <https://developer.apple.com/account> under Membership details.

### 2. Export the certificate as .p12

1. Open Keychain Access, choose the **login** keychain and the **My Certificates** tab.
2. Find **Developer ID Application: Your Name (TEAMID)**. Expand it and check that a private key is under it. Without the key the export is useless.
3. Right-click the certificate (not the key), choose **Export "Developer ID Application: …"**, pick the format **Personal Information Exchange (.p12)** and save it, for example as `~/Desktop/devid.p12`.
4. Enter a strong password for the file. You'll store it as a secret below.

Keep the `.p12` somewhere safe (a password manager) or delete it after adding the secret. Anyone with the file and its password can sign apps as you.

### 3. Create an App Store Connect API key for notarization (recommended)

1. Go to <https://appstoreconnect.apple.com/access/integrations/api> (Users and Access > Integrations > App Store Connect API).
2. The first time, the Account Holder has to click **Request Access** and accept the terms.
3. Under **Team Keys**, click **Generate API Key** (or **+**). Name it, for example "GitHub notarization", and give it the role **Developer**. That's enough for notarization.
4. Download the `AuthKey_XXXXXXXXXX.p8` file. **You can download it only once.**
5. Note the **Key ID** (shown in the row) and the **Issuer ID** (shown above the table).

**Alternative: Apple ID plus app-specific password.** Create an app-specific password at <https://account.apple.com> > Sign-In and Security > App-Specific Passwords. This works, but it's tied to your personal Apple ID and breaks if you change your password. The API key is preferred.

### 4. Add the repository secrets

Use the GitHub CLI from the repo directory. Every command below reads the value from a file, a pipe or a hidden prompt, so no secret ends up in your shell history.

```sh
cd ~/Sites/lillefar/claude-safari

# Certificate (.p12, base64-encoded) and its password (hidden prompt)
base64 -i ~/Desktop/devid.p12 | gh secret set MACOS_CERTIFICATE_P12_BASE64
gh secret set MACOS_CERTIFICATE_PASSWORD

# Team ID (prompt; paste the 10-character id)
gh secret set APPLE_TEAM_ID

# Notarization with the App Store Connect API key (recommended)
base64 -i ~/Downloads/AuthKey_XXXXXXXXXX.p8 | gh secret set APPSTORE_CONNECT_API_KEY_P8_BASE64
gh secret set APPSTORE_CONNECT_API_KEY_ID      # e.g. XXXXXXXXXX
gh secret set APPSTORE_CONNECT_ISSUER_ID       # a UUID

# ...or with an Apple ID instead (only if you skipped the API key)
# gh secret set APPLE_ID
# gh secret set APPLE_APP_SPECIFIC_PASSWORD

gh secret list
```

| Secret | Required | Value |
| --- | --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | yes | base64 of the exported `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | yes | the `.p12` export password |
| `APPLE_TEAM_ID` | yes | your 10-character Team ID |
| `APPSTORE_CONNECT_API_KEY_P8_BASE64` | API key option | base64 of `AuthKey_….p8` |
| `APPSTORE_CONNECT_API_KEY_ID` | API key option | Key ID |
| `APPSTORE_CONNECT_ISSUER_ID` | API key option | Issuer ID |
| `APPLE_ID` | Apple ID option | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple ID option | app-specific password |

If both notarization options are set, the API key is used.

### 5. Bundle IDs (optional)

You don't need to register `dk.lillefar.sendtoclaude` or `dk.lillefar.sendtoclaude.Extension` as App IDs. Developer ID signing doesn't use provisioning profiles for an app that only uses the app sandbox, network client and user-selected-files entitlements, as this one does. You'd only need to register the IDs and create a Developer ID provisioning profile if you later add a capability that requires one, for example App Groups or iCloud. Registering them anyway at <https://developer.apple.com/account/resources/identifiers/list> does no harm and reserves the names.

## Cutting a release

```sh
git tag v1.0.0
git push origin v1.0.0
```

Watch it with `gh run watch` or on the Actions tab. When it's done, the release is at <https://github.com/lajlev/claude-safari/releases/latest>.

You can also run the workflow manually (Actions > Release > Run workflow, or `gh workflow run release.yml -f version=1.0.1`). It always uploads the zip as a workflow artifact. It creates a release and tag only if you tick **publish** (`-f publish=true`).

To verify a download:

```sh
shasum -a 256 -c Send-to-Claude-1.0.0.zip.sha256
ditto -x -k Send-to-Claude-1.0.0.zip /tmp/stc && spctl -a -vvv -t exec "/tmp/stc/Send to Claude.app"
# ... accepted  source=Notarized Developer ID
```

## Releasing from your Mac (optional)

With the certificate in your login keychain, you can build the same signed and notarized zip locally. First, store the notarization credentials in your keychain once:

```sh
xcrun notarytool store-credentials sendtoclaude \
  --key ~/Downloads/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer-uuid>
# (or: --apple-id you@example.com --team-id ABCDE12345, which prompts for the password)
```

Then:

```sh
NOTARY_KEYCHAIN_PROFILE=sendtoclaude make release-local VERSION=1.0.0
# signed only, not notarized (for testing, don't publish):
NOTARIZE=0 make release-local VERSION=1.0.0
```

The output is in `dist/`. This runs `./build.sh clean` first, so run `make` again afterwards if you want the ad hoc dev build back.

## Troubleshooting

**Notarization status "Invalid".** The script prints the notary log automatically. To fetch it again:

```sh
xcrun notarytool history --keychain-profile sendtoclaude
xcrun notarytool log <submission-id> --keychain-profile sendtoclaude
# or with the API key: --key AuthKey_X.p8 --key-id X --issuer Y
```

Common issues in the log:

- *"The executable does not have the hardened runtime enabled."* `ENABLE_HARDENED_RUNTIME=YES` didn't reach a target. `codesign -dvv <bundle>` should show `flags=0x10000(runtime)` for both the app and `Contents/PlugIns/*.appex`.
- *"The signature does not include a secure timestamp."* `OTHER_CODE_SIGN_FLAGS=--timestamp` is missing, or Apple's timestamp server couldn't be reached during signing. Re-run the job.
- *"The executable requests the com.apple.security.get-task-allow entitlement."* The app was built with `build` instead of `archive`, or with a development certificate. Release mode uses `xcodebuild archive` for this reason. The script also checks for this before uploading.
- *"The binary is not signed with a valid Developer ID certificate."* The `.p12` holds an Apple Development or Apple Distribution certificate, or the certificate expired or was revoked. Export the **Developer ID Application** one.

**"no identity found" or "errSecInternalComponent" during signing in CI.** The `.p12` lacks the private key (export the certificate from **My Certificates** with the key under it), or the password secret is wrong. The import step fails early with a message if no valid Developer ID identity is found.

**`security import` fails with "MAC verification failed".** Wrong `MACOS_CERTIFICATE_PASSWORD`. Some newer `.p12` encryption formats also fail with older `security` tools. Re-export from Keychain Access on your Mac, which works with the runner's macOS.

**Safari doesn't show the extension after installing.** Open the app once from /Applications, then check Safari > Settings > Extensions. `pluginkit -m -v -i dk.lillefar.sendtoclaude.Extension` shows whether macOS registered it. The app and the extension must be signed by the same team; `codesign -dvv` shows `TeamIdentifier`.

**Sandbox.** Safari requires both the app and the extension to be sandboxed. The converter enables this with `ENABLE_APP_SANDBOX=YES` and related build settings, which Xcode turns into entitlements at signing time. The release script fails if `com.apple.security.app-sandbox` is missing from either bundle. Check it with `codesign -d --entitlements - <bundle>`.

**The runner's Xcode moved on.** The workflow pins `XCODE_APP` (currently `/Applications/Xcode_26.6.app` on `macos-26`). If GitHub removes that version, the job warns and falls back to the image's default Xcode. Update the pin to an Xcode listed in the [runner image README](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md).
