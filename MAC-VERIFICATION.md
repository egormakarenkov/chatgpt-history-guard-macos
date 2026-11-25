# Mac acceptance checks

Status: **pending on a Mac**. Windows offline tests do not complete these checks.

1. Build against official ChatGPT 26.930.61225 using README commands. Confirm codesign --verify --deep --strict succeeds; builder also verifies requested fuses and unpacked ASAR metadata.
2. Set owner password with app quit. Launch output, confirm separate profile/fresh login and unchanged original app/profile.
3. Using a test account with a known old chat, try its link/UUID, search, shares, projects, custom-GPT history and library. No old title, preview or message should appear. Do not publish credentials or private captures.
4. Create a new chat. Verify streaming, enrollment before render, subsequent sends, reopening and pagination. Test current server delta streams; unsupported formats must remain locked.
5. Restart. Verify trusted account startup restores approvals. Switch accounts: approvals must not transfer. Expiry/sign-out during a stream must stop protected responses.
6. Try localStorage spoofing/direct renderer HTTP. Neither may approve old IDs. Missing guard/preload or corrupt policy must lock cloud routes while local Codex remains usable.
7. Verify developer menu/F12/inspector flags and account-chat navigation restrictions. Login and ordinary external documentation links should work.
8. Quit, try wrong owner password (refused), then correct reset (revokes all). Relaunch: previous approvals locked, fresh new chat possible.
9. Verify local Codex project creation, thread opening and a simple command. Arbitrary command access remains an app-level bypass; OS/account separation is needed.

If endpoints or protocols differ, preserve fail-closed behavior and update source/tests before distribution. Never substitute offline results for these pending checks.

