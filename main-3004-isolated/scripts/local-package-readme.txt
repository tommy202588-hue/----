X-tapnow 3004 local package
===========================

Windows:
1. Extract the complete *-win-x64 ZIP to a normal local folder.
2. Double-click start-local.cmd.

macOS:
1. Apple Silicon / M series chips: use *-mac-arm64.tar.gz.
2. Intel chips: use *-mac-x64.tar.gz.
3. Extract the complete package to a normal local folder.
4. Double-click start-local-mac.command. If macOS says it cannot be opened, run this once in Terminal from the extracted folder:

    chmod +x start-local-mac.command start-local.sh runtime/node

   Then double-click start-local-mac.command again.
5. If macOS blocks the downloaded runtime, use right-click > Open once, then run the script again.

The canvas opens automatically in the default browser. Keep the terminal or
command window open while using it. Close that window or press Ctrl+C to stop.

Default address: http://localhost:3004

If port 3004 is occupied, the launcher selects the next available port.
To request a specific port, run:

    start-local.cmd --port=4000
    bash start-local.sh --port=4000

Each colleague runs the package on their own computer, so no connection to
your 3003 or shared LAN is required. Other devices on the same trusted LAN
can use the LAN address printed in the command window. Windows Firewall or
macOS network permission may ask for approval on first start.

API keys are not included in this package. Each user must configure their
own providers in Settings. Browser settings are stored on that computer.
