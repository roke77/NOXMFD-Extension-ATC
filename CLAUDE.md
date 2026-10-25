# Development practices

## Build & deploy

- After any code change, run `dotnet build -c Release` before calling it done, not just a
  compile check or the browser preview. The page's HTML/CSS/JS are embedded resources in the DLL,
  so an edit reaches the game only through a rebuild. The build's `DeployToGame` target copies the
  DLL into `$(GameDir)\BepInEx\plugins` (from the local, gitignored `GameDir.props`); confirm its
  "Deployed … to …" line.
- The game loads plugins at startup: restart it to pick up a new DLL. A running game can lock the
  DLL and make the copy fail.
- `BepInDependency` on `com.roque.NOXMFD` is a hard floor: against an older NOXMFD, BepInEx skips
  this plugin and only says so in `BepInEx/LogOutput.log` ("missing dependencies"). To test a floor
  NOXMFD hasn't released yet, build NOXMFD with `-p:Version=<floor>` rather than editing its csproj.
