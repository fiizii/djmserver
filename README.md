### Setup
1. Run `install.bat`.
2. Run `node index.js`. (First run generates config and exits).
3. Edit `.mrepo/conf.yaml`: set `ready: true` and copy the `key`.
4. Run `node index.js`.

### 2. Host (DevTunnel)
To share your library, expose port 3000 (or whatever port youve set). You **must** use `--allow-anonymous` so its a public share..

```bash
winget install Microsoft.Devtunnels
devtunnel user login
devtunnel host -p 3000 --allow-anonymous
```
*Copy the `https://...` URL provided.*

### 3. Sync
1. Go to `http://localhost:3000/admin`.
2. Login with your `key`.
3. Add Remote: Enter a Name and the DevTunnel URL.
4. Click **SYNC**.

*Syncing happens in the background. Check your terminal for progress bars and logs.*
