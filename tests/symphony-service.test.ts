import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
  symlink,
  unlink,
  utimes,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const { jiraEnvironment, serviceUnit, serviceNameFor, serviceLogCommand } =
  await import(new URL("../symphony/service.mjs", import.meta.url).href);
const projectName = "Demo Storylines";
const serviceName = serviceNameFor(projectName);
const projectManifest = `project:\n  name: ${projectName}\n`;

test("runtime logs select the newest readable numbered segment and exclude metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "symphony-log-select-"));
  try {
    const runtime = join(directory, 'runtime $(literal) "quote"');
    const logs = join(runtime, ".symphony/logs/log");
    await mkdir(logs, { recursive: true });
    for (const name of [
      "symphony.log.1",
      "symphony.log.2",
      "symphony.log.idx",
      "symphony.log.siz",
    ])
      await writeFile(join(logs, name), "synthetic\n");
    await utimes(join(logs, "symphony.log.1"), 1000, 1000);
    await utimes(join(logs, "symphony.log.2"), 2000, 2000);
    await symlink(join(logs, "symphony.log.idx"), join(logs, "symphony.log.3"));
    assert.deepEqual(await serviceLogCommand(runtime), {
      command: "tail",
      args: ["--lines=100", "--", join(logs, "symphony.log.2")],
    });
    assert.deepEqual(await serviceLogCommand(runtime, true), {
      command: "tail",
      args: [
        "--lines=100",
        "--follow=name",
        "--retry",
        "--quiet",
        "--",
        ...[1, 2, 3, 4, 5].map((part) => join(logs, `symphony.log.${part}`)),
      ],
    });
    await assert.rejects(serviceLogCommand("relative"), /must be absolute/);
    await assert.rejects(
      serviceLogCommand(directory),
      /No readable runtime log directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "logs CLI resolves the installed runtime and passes paths as literal argv, with explicit journal and follow controls",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "symphony-log-cli-"));
    try {
      const runtime = join(
        directory,
        'runtime $(touch should-never-run) "quote"',
      );
      const logs = join(runtime, ".symphony/logs/log");
      const bin = join(directory, "bin");
      const captured = join(directory, "captured-args.json");
      await mkdir(logs, { recursive: true });
      await mkdir(bin);
      await writeFile(join(logs, "symphony.log.1"), "synthetic\n");
      await writeFile(
        join(bin, "systemctl"),
        '#!/bin/sh\nprintf "%s\\n" "$TEST_RUNTIME_DIRECTORY"\n',
      );
      await chmod(join(bin, "systemctl"), 0o755);
      for (const command of ["tail", "journalctl"]) {
        await writeFile(
          join(bin, command),
          `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.TEST_TOOL_ARGS, JSON.stringify({ command: '${command}', args: process.argv.slice(2) }));\n`,
        );
        await chmod(join(bin, command), 0o755);
      }
      const script = fileURLToPath(
        new URL("../symphony/service.mjs", import.meta.url),
      );
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_RUNTIME_DIRECTORY: runtime,
        TEST_TOOL_ARGS: captured,
      };
      await writeFile(join(directory, "project.yaml"), projectManifest);
      const cwd = directory;
      await execute(process.execPath, [script, "logs"], { env, cwd });
      assert.deepEqual(JSON.parse(await readFile(captured, "utf8")), {
        command: "tail",
        args: ["--lines=100", "--", join(logs, "symphony.log.1")],
      });
      await execute(process.execPath, [script, "logs", "--follow"], {
        env,
        cwd,
      });
      const followed = JSON.parse(await readFile(captured, "utf8"));
      assert.equal(followed.command, "tail");
      assert.deepEqual(
        followed.args,
        (await serviceLogCommand(runtime, true)).args,
      );
      await execute(
        process.execPath,
        [script, "logs", "--journal", "--follow"],
        { env, cwd },
      );
      assert.deepEqual(JSON.parse(await readFile(captured, "utf8")), {
        command: "journalctl",
        args: [
          "--user",
          "--unit",
          serviceName,
          "--lines",
          "100",
          "--no-pager",
          "--follow",
        ],
      });
      await assert.rejects(
        execute(process.execPath, [script, "logs", "--bad"], { env, cwd }),
        /logs accepts only --follow and --journal/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
const execute = promisify(execFile);
const source = (token = "synthetic-token") =>
  `JIRA_BASE_URL=https://fixture.atlassian.net\nJIRA_EMAIL=fixture@example.com\nJIRA_API_TOKEN='${token}'\nDATABASE_PASSWORD=do-not-copy\nOPENAI_API_KEY=do-not-copy\n`;

test("service extracts only Jira values and preserves shell metacharacters literally", () => {
  const value = jiraEnvironment(source('synthetic\\token" $HOME `id`'));
  assert.equal(
    value,
    'JIRA_BASE_URL="https://fixture.atlassian.net"\nJIRA_EMAIL="fixture@example.com"\nJIRA_API_TOKEN="synthetic\\\\token\\" $HOME `id`"\n',
  );
  assert.doesNotMatch(value, /DATABASE_PASSWORD|OPENAI_API_KEY|do-not-copy/);
  assert.equal(
    jiraEnvironment(source().replaceAll("\n", "\r\n")),
    jiraEnvironment(source()),
  );
});

test("service rejects missing credentials, unsafe URLs, and control characters without disclosing credentials", () => {
  assert.throws(
    () => jiraEnvironment("JIRA_BASE_URL=https://fixture.atlassian.net\n"),
    /Missing JIRA_EMAIL/,
  );
  for (const invalid of [
    source().replace(
      "https://fixture.atlassian.net",
      "http://fixture.atlassian.net",
    ),
    source().replace(
      "https://fixture.atlassian.net",
      "https://private:secret@fixture.atlassian.net",
    ),
    source().replace("fixture@example.com", "invalid-email"),
    ...["\n", "\r", "\t", "\0", "\x7f"].map((control) =>
      source(`synthetic${control}tail`),
    ),
  ]) {
    assert.throws(
      () => jiraEnvironment(invalid),
      (error: Error) => {
        assert.doesNotMatch(error.message, /synthetic|private:secret/);
        return true;
      },
    );
  }
});

test("unit uses absolute commands and escapes systemd specifiers and command dollar expansion", () => {
  const unit = serviceUnit({
    projectName,
    runtime: "/tmp/work 100%/$project",
    node: "/opt/node $binary/%version/node",
    codex: "/opt/codex/bin/codex",
    environment: '/tmp/private/"quote"/back\\slash/%percent/$value.env',
    sshIdentity: "/tmp/private/owner's key",
  });
  assert.ok(unit.includes("WorkingDirectory=/tmp/work 100%%/$project\n"));
  assert.ok(
    unit.includes(
      'EnvironmentFile=/tmp/private/"quote"/back\\slash/%%percent/$value.env\n',
    ),
  );
  assert.ok(
    unit.includes(
      'ExecStart="/opt/node $$binary/%%version/node" "/tmp/work 100%%/$$project/.project-os/symphony/start.mjs"\n',
    ),
  );
  assert.match(unit, /^Description=Demo Storylines Symphony Jira worker$/m);
  assert.match(unit, /^SyslogIdentifier=demo-storylines-symphony$/m);
  assert.equal(serviceName, "demo-storylines-symphony.service");
  assert.throws(
    () =>
      serviceUnit({
        projectName: "Name\nExecStart=bad",
        runtime: "/tmp/work",
        node: "/bin/node",
        codex: "/bin/codex",
        environment: "/tmp/env",
      }),
    /control characters/,
  );
  assert.match(unit, /-o IdentitiesOnly=yes -o BatchMode=yes/);
  assert.match(unit, /UnsetEnvironment=NODE_OPTIONS NODE_PATH/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /UMask=0077/);
  assert.doesNotMatch(unit, /synthetic-token|JIRA_API_TOKEN=/);
  assert.throws(
    () =>
      serviceUnit({
        projectName,
        runtime: "relative",
        node: "/bin/node",
        codex: "/bin/codex",
        environment: "/tmp/env",
      }),
    /absolute/,
  );
  assert.throws(
    () =>
      serviceUnit({
        projectName,
        runtime: "/tmp/work\nExecStart=bad",
        node: "/bin/node",
        codex: "/bin/codex",
        environment: "/tmp/env",
      }),
    /control characters/,
  );
  for (const environment of ["/tmp/env ", "/tmp/env\\"]) {
    assert.throws(
      () =>
        serviceUnit({
          projectName,
          runtime: "/tmp/work",
          node: "/bin/node",
          codex: "/bin/codex",
          environment,
        }),
      /cannot end with whitespace or a backslash/,
    );
  }
});

test(
  "installer only reloads; dispatch requires the separate explicit start command",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "symphony-installer-test-"));
    try {
      const home = join(directory, "home");
      const runtime = join(directory, "runtime");
      const bin = join(directory, "bin");
      const calls = join(directory, "systemctl-calls");
      const environmentSource = join(directory, "input.env");
      await Promise.all([
        mkdir(home),
        mkdir(bin),
        mkdir(join(runtime, ".symphony/bin"), { recursive: true }),
        mkdir(join(runtime, ".project-os/symphony"), { recursive: true }),
      ]);
      const codex = join(bin, "codex");
      for (const executable of [
        codex,
        join(runtime, ".symphony/bin/symphony"),
      ]) {
        await writeFile(executable, "#!/bin/sh\nexit 0\n");
        await chmod(executable, 0o755);
      }
      await writeFile(
        join(bin, "systemctl"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_SYSTEMCTL_CALLS"\n',
      );
      await chmod(join(bin, "systemctl"), 0o755);
      await writeFile(join(runtime, "WORKFLOW.md"), "synthetic workflow\n");
      await writeFile(join(runtime, "project.yaml"), projectManifest);
      await writeFile(
        join(runtime, ".project-os/symphony/start.mjs"),
        "// synthetic launcher\n",
      );
      await writeFile(environmentSource, source());
      const script = fileURLToPath(
        new URL("../symphony/service.mjs", import.meta.url),
      );
      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_SYSTEMCTL_CALLS: calls,
      };
      const installed = await execute(
        process.execPath,
        [
          script,
          "install",
          "--runtime",
          runtime,
          "--env-source",
          environmentSource,
          "--codex",
          codex,
        ],
        { env },
      );
      assert.equal(await readFile(calls, "utf8"), "--user daemon-reload\n");
      assert.doesNotMatch(
        installed.stdout + installed.stderr,
        /synthetic-token|do-not-copy/,
      );
      const privateEnvironment = join(
        home,
        ".config/demo-storylines/symphony.env",
      );
      assert.equal(
        await readFile(privateEnvironment, "utf8"),
        jiraEnvironment(source()),
      );
      assert.equal((await stat(privateEnvironment)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(join(home, ".config/demo-storylines"))).mode & 0o777,
        0o700,
      );
      const unit = await readFile(
        join(home, ".config/systemd/user", serviceName),
        "utf8",
      );
      assert.doesNotMatch(unit, /synthetic-token|do-not-copy/);
      await execute(process.execPath, [script, "start"], {
        env,
        cwd: runtime,
      });
      assert.equal(
        await readFile(calls, "utf8"),
        `--user daemon-reload\n--user enable --now ${serviceName}\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "generated unit loads literal paths in the actual systemd user manager without warnings or starting",
  {
    skip:
      process.platform !== "linux" || process.env.SYMPHONY_SYSTEMD_TEST !== "1",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "symphony-systemd-test-"));
    const name = `symphony-service-verify-${process.pid}.service`;
    const units = join(homedir(), ".config/systemd/user");
    const link = join(units, name);
    let linked = false;
    try {
      const environment = join(
        directory,
        'literal space %percent $dollar "quote" back\\slash.env',
      );
      await writeFile(environment, 'JIRA_API_TOKEN="synthetic"\n', {
        mode: 0o600,
      });
      const unit = join(directory, name);
      await writeFile(
        unit,
        serviceUnit({
          projectName,
          runtime: process.cwd(),
          node: process.execPath,
          codex: "/usr/bin/true",
          environment,
        }),
      );
      const verified = await execute("systemd-analyze", [
        "--user",
        "verify",
        unit,
      ]);
      assert.equal(
        verified.stderr,
        "",
        "Unit verification warnings must fail even when exit status is zero",
      );
      await mkdir(units, { recursive: true });
      await symlink(unit, link);
      linked = true;
      await execute("systemctl", ["--user", "daemon-reload"]);
      const loaded = await execute("systemctl", [
        "--user",
        "show",
        name,
        "-p",
        "EnvironmentFiles",
        "-p",
        "WorkingDirectory",
        "-p",
        "ActiveState",
      ]);
      assert.equal(loaded.stderr, "");
      const properties = loaded.stdout.split("\n");
      assert.ok(
        properties.includes(
          `EnvironmentFiles=${environment} (ignore_errors=no)`,
        ),
      );
      assert.ok(properties.includes(`WorkingDirectory=${process.cwd()}`));
      assert.ok(properties.includes("ActiveState=inactive"));
    } finally {
      if (linked) {
        await unlink(link);
        await execute("systemctl", ["--user", "daemon-reload"]);
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
