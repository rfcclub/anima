import { describe, expect, test } from "bun:test";
import { redactSecrets, scanSecrets } from "../../src/work/publish-secrets";

const githubToken = "ghp_" + "a".repeat(36);
const skKey = "sk-" + "aB3dE5fG7hI9jK1l" + "M3nO";
const awsId = "AKIA" + "A1B2C3D4" + "E5F6G7H8";
const awsSecret = "A1b2C3d4E5f6G7h8" + "I9j0K1l2M3n4O5p6Q7r8S9t0";
const slackToken = "xoxb-" + "1234567890" + "1234567890";
const googleKey = "AIza" + "0123456789" + "abcdefghij" + "ABCDEFGHIJKLMNO";
const jwt = "eyJ" + "A1b2C3d4E5fG7h8" + "." + "eyJ" + "aB3dE5fG7hI9jK1l" + "." + "A1b2C3d4E5fG7h8";
const highEntropyToken = "aB3dE5fG7hI9jK1l" + "MnOpQrStUvWxYz01";
const hex32 = "0123456789abcdef".repeat(2);
const hex40 = "0123456789abcdef".repeat(2) + "01234567";
const hex64 = "0123456789abcdef".repeat(4);
const pem = "-----BEGIN RSA " + "PRIVATE KEY-----\n" + "key-material-line\n" + "-----END RSA " + "PRIVATE KEY-----";

const secretCases: Array<[string, string]> = [
  ["private-key block", pem],
  ["GitHub token", githubToken],
  ["sk key", skKey],
  ["AWS access key id", awsId],
  ["AWS secret access key", `aws_secret_access_key=${awsSecret}`],
  ["Slack token", slackToken],
  ["Google API key", googleKey],
  ["JWT", jwt],
  ["sensitive assignment", `PASSWORD = "${highEntropyToken}"`],
  ["high-entropy token", highEntropyToken],
];

describe("scanSecrets", () => {
  test("SC-011 refuses and redacts a GitHub token without returning it", () => {
    expect(scanSecrets(`before ${githubToken} after`)).toBe("github-token");
    const redacted = redactSecrets(`before ${githubToken} after`);
    expect(redacted).not.toContain(githubToken);
    expect(redacted).toBe("before [redacted] after");
  });

  test("SC-034 refuses random-looking 40, 64, and 32 character hex credentials", () => {
    expect(scanSecrets(`KEY = "${hex40}"`)).not.toBeNull();
    expect(scanSecrets(hex64)).not.toBeNull();
    expect(scanSecrets(hex32)).not.toBeNull();
  });

  test.each(secretCases)("finds %s", (_name, value) => {
    expect(scanSecrets(value)).not.toBeNull();
  });

  test("finds a PEM header even when the block has no END line", () => {
    expect(scanSecrets("-----BEGIN " + "PRIVATE KEY-----\npartial body")).toBe("private-key");
  });

  test("redacts the entire PEM block, including its body", () => {
    expect(redactSecrets(`before\n${pem}\nafter`)).toBe("before\n[redacted]\nafter");
  });

  test("finds AWS secret access keys with equals, colon, quote, and whitespace-quote separators", () => {
    for (const separator of ["=", ":", "'", "\"", " '\"", " \""]) {
      expect(scanSecrets(`aws_secret_access_key${separator}${awsSecret}`)).not.toBeNull();
    }
  });

  test("SC-005 detects slash-containing credentials after URLs and prose", () => {
    const slashToken = highEntropyToken.slice(0, 3) + "/" + highEntropyToken.slice(3);
    for (const sample of [
      `see https://api.example.com/x then token ${slashToken} here`,
      `from upstream: ${slashToken}`,
      `fetched from https://a.b/c the key ${slashToken}`,
      `https://api.example.com/${slashToken}/send`,
    ]) {
      expect(scanSecrets(sample)).not.toBeNull();
      expect(redactSecrets(sample)).not.toContain(slashToken);
    }
  });

  test("finds and redacts base64 credentials in URL paths and after dots or prose", () => {
    const slashToken = "aB3dE5fG7hI9/" + "jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9";
    const urlWithSlashToken = `https://api.example.com/${slashToken}/send`;
    expect(redactSecrets(urlWithSlashToken)).toBe("https://api.example.[redacted]");
    const multiSlashToken = [highEntropyToken.slice(0, 12), highEntropyToken.slice(12, 22), highEntropyToken.slice(22)].join("/");
    const urlWithMultiSlashToken = `https://api.example.com/${multiSlashToken}/send`;
    expect(redactSecrets(urlWithMultiSlashToken)).toBe("https://api.example.[redacted]");
    const samples = [
      `https://api.example.com/${highEntropyToken}/send`,
      urlWithSlashToken,
      `see https://api.example.com/x then token ${highEntropyToken} here`,
      `from upstream: ${highEntropyToken}`,
      `fetched from https://a.b/c the key ${highEntropyToken}`,
      `value ${highEntropyToken}.`,
    ];
    for (const sample of samples) {
      expect(scanSecrets(sample)).not.toBeNull();
      expect(redactSecrets(sample)).not.toContain(highEntropyToken);
    }
  });

  test("SC-010 requires at least 16 characters for a sensitive assignment", () => {
    expect(scanSecrets(`PASSWORD=${highEntropyToken.slice(0, 15)}`)).toBeNull();
    expect(scanSecrets(`PASSWORD=${highEntropyToken.slice(0, 16)}`)).toBe("sensitive-assignment");
  });

  test("finds dotted sensitive assignment values unless explicitly code-referenced", () => {
    for (const line of [
      "password=correct.horse.battery.staple",
      "api_key=prod.internal.key.value1",
      "password=hunter2.hunter2.hunter2",
      "password=prod.my.password",
      "db_password=corp.db_password",
    ]) {
      expect(scanSecrets(line)).not.toBeNull();
    }
    for (const code of [
      "password=options.password",
      "password=this.password",
      "password=config.prod.value123",
      "password=env.VALUE",
      "sessionToken=options.sessionToken",
      "const x = process.env.PASSWORD",
    ]) {
      expect(scanSecrets(code)).toBeNull();
    }
  });

  test("does not flag ordinary identifiers, words, paths, URLs, or environment variable names", () => {
    for (const ordinary of [
      "reduceIncidentsForEveryCheck",
      "aVeryLongIdentifierWithNoDigits",
      "src/work/publish-secrets.ts",
      "https://api.example.com/v1/users/profile",
      "process.env.GITHUB_TOKEN",
      "SESSION_TOKEN",
      "password",
      "import { publishCommittedWork } from './publish-fallback'",
    ]) {
      expect(scanSecrets(ordinary)).toBeNull();
    }
  });

  test("redacts every supported secret kind and leaves ordinary text unchanged", () => {
    for (const [_name, value] of secretCases) {
      const redacted = redactSecrets(`prefix ${value} suffix`);
      expect(redacted).not.toContain(value);
      expect(scanSecrets(value)).not.toContain(value);
    }
    expect(redactSecrets("ordinary text and src/work/file.ts")).toBe("ordinary text and src/work/file.ts");
  });

  describe("regressions", () => {
    // deterministic pseudo-random bytes, so the property test never flakes
    const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const randomBase64 = (next: () => number, bytes: number) =>
      Buffer.from(Array.from({ length: bytes }, () => Math.floor(next() * 256))).toString("base64").replace(/=+$/, "");

    test("a JSON key in quotes does not hide its value", () => {
      for (const line of [
        '{"api_key": "s3cr3tPassw0rdValue9"}',
        '"password": "correct.horse.battery"',
        "{'secret': 'abcdefghij0123456789'}",
      ]) {
        expect(scanSecrets(line)).toBe("sensitive-assignment");
        expect(redactSecrets(line)).not.toMatch(/s3cr3tPassw0rdValue9|correct\.horse|abcdefghij0123456789/);
      }
    });

    test("random base64 credentials that contain slashes are always found, in any context", () => {
      const next = rng(7);
      let withSlash = 0;
      for (let i = 0; i < 600; i++) {
        const token = randomBase64(next, 24 + Math.floor(next() * 24));
        if (token.includes("/")) withSlash++;
        for (const sample of [`token ${token} end`, `https://api.example.com/${token}/send`, `from: ${token}.`, `x=${token}`]) {
          expect(scanSecrets(sample)).not.toBeNull();
          const redacted = redactSecrets(sample);
          expect(redacted).not.toContain(token.slice(0, 12));
          expect(redacted).not.toContain(token.slice(-12));
        }
      }
      expect(withSlash).toBeGreaterThan(100);
    });

    test("a credential split by short slash pieces is found (28/4, 12/1/19, 16/4/16)", () => {
      const t = highEntropyToken + highEntropyToken.slice(0, 6); // 38 characters
      for (const token of [`${t.slice(0, 28)}/${t.slice(28, 32)}`, `${t.slice(0, 12)}/${t.slice(12, 13)}/${t.slice(13, 32)}`, `${t.slice(0, 16)}/${t.slice(16, 20)}/${t.slice(20, 36)}`]) {
        expect(scanSecrets(`value ${token} here`)).not.toBeNull();
        expect(redactSecrets(`value ${token} here`)).toBe("value [redacted] here");
      }
    });

    test("a short piece after the credential is redacted with it, not left behind", () => {
      expect(redactSecrets(`${highEntropyToken}/A1b`)).toBe("[redacted]");
    });

    test("hex credentials are found after an assignment, a colon or a quote", () => {
      for (const prefix of ["KEY=", "token: ", "secret='", "x:"]) {
        expect(scanSecrets(`${prefix}${hex32}`)).not.toBeNull();
        expect(redactSecrets(`${prefix}${hex64}`)).not.toContain(hex64.slice(0, 20));
      }
    });
  });

  describe("review regressions", () => {
    test("passwords with special characters are found and redacted, quoted or bare", () => {
      for (const [line, secret] of [
        ["password=Tr0ub4dor&3-Corral!Battery#Staple", "Tr0ub4dor"],
        ['DB_PASSWORD="S3cr3t!Pa$$w0rd-Prod-2026"', "S3cr3t"],
        ["secret: p@ssw0rd_super_long_value_here", "p@ssw0rd"],
        ["api_key='x!y@z#1234567890abcdef'", "x!y@z"],
      ] as const) {
        expect(scanSecrets(line)).toBe("sensitive-assignment");
        expect(redactSecrets(line)).not.toContain(secret);
      }
      expect(scanSecrets("password=short!1")).toBeNull();
      for (const code of ["secret=readFileSync(join(root, name))", "token=${gatewayToken}", "tokens=messageTokens(prior[i]!)", "secret=readFileSync(join(root, \"x\"), \"utf8\").trim()"]) {
        expect(scanSecrets(code)).toBeNull();
      }
      for (const text of ["password=Hunter(2)IsMySecretPass!!", "password=Pass(word)123!xyzABCDEFG", "PASSWORD=${SuperSecretValue123456}tail-of-it", "password=a(1).Hunter2IsMySecretPass", "password=x(1).Hunter2IsMySecretPass.more!!"]) {
        expect(scanSecrets(text)).toBe("sensitive-assignment");
        expect(redactSecrets(text)).not.toMatch(/Hunter|Pass\(word|SuperSecret/);
      }
    });

    test("a 32 character credential needs no digit or capital letter", () => {
      const lowerOnly = "abcdefghijklmnopqrstuvwxyz" + "abcdef";
      const lowerDigits = "abcdefghijklmnopqrstuvwxyz" + "012345";
      const plusSlash = "qPVzLhKNcX+yw/Rs" + "DeafBUmTGjkoWIpA";
      for (const token of [lowerOnly, lowerDigits, plusSlash]) {
        for (const sample of [token, `https://api.example.com/${token}/send`, `key ${token} end`]) {
          expect(scanSecrets(sample)).not.toBeNull();
          expect(redactSecrets(sample)).not.toContain(token.slice(0, 10));
        }
      }
    });

    test("identifier shapes of any length are still not flagged", () => {
      for (const ordinary of [
        "reduceIncidentsForEveryCheckAndRecordTheirOutcomes",
        "ReduceIncidentsForEveryCheckAndRecordTheirOutcomes",
        "reduce_incidents_for_every_check_and_record_outcomes",
        "reduce-incidents-for-every-check-and-record-outcomes",
        "REDUCE_INCIDENTS_FOR_EVERY_CHECK_AND_RECORD_OUTCOMES",
        "packages/context-engine/src/ingestion-pipeline/stages",
        "node_modules/typescript_internal/lib_files/x_files_of_it",
        "src/work/publish_secrets_helper/index_files",
        "https://github.com/rfcclub/anima/pull/367/files",
        "https://github.com/rfcclub/jade-substrate/blob/master/README",
        "https://github.com/rfcclub/colony-mesh/issues/12",
        "computeStrengthsForEveryIncidentCheck",
        "garden/briefs/projection/narrative/places/presence",
        "packages/castle-vn/engine/stage/scene/render/loader",
        "continuity/reflection/engine/agents/prompter/memory",
        "channels/telegram/agent-session/handler/session/manager",
        "https://api.example.com/v1/users/profile/2024/06/17/events",
        "see https://api.example.com/v2/organizations/12345/repositories/67890/pulls/367/files",
      ]) {
        expect(scanSecrets(ordinary)).toBeNull();
      }
    });

    test("a quoted password with an escaped quote is redacted to its real end", () => {
      for (const line of [
        'password="abcdefghijklmnop\\"SecretSuffix987654321"',
        "token='abcdefghijklmnop\\'SecretSuffix987654321'",
      ]) {
        expect(scanSecrets(line)).toBe("sensitive-assignment");
        expect(redactSecrets(line)).not.toContain("SecretSuffix");
        expect(redactSecrets(line)).toMatch(/\[redacted\]["']$/);
      }
    });

    test("a credential with an inner = is one candidate run", () => {
      const a = highEntropyToken.slice(0, 20);
      const b = highEntropyToken.slice(4);
      for (const sample of [`key=${a}=${b}`, "aB3dE5fG7hI9jK1l=MnOpQrStUvWxYz01", `https://api.example.com/x?k=${a}=${b}&z=1`]) {
        expect(scanSecrets(sample)).not.toBeNull();
        const redacted = redactSecrets(sample);
        expect(redacted).not.toContain(a.slice(0, 12));
        expect(redacted).not.toContain(b.slice(-12));
      }
      expect(scanSecrets("====================================================")).toBeNull();
    });

    test("a lowercase/digit credential cut by a slash into short pieces is a token, not a path", () => {
      for (const token of ["qwertyuiopasdfgh/jklzxcvbnm0123456789", "0123456789abcdef/ghijklmnopqrstuv", "abcdefghijklmnop/qrstuvwxyz012345/6789abcd"]) {
        for (const sample of [token, `key ${token} end`, `https://api.example.com/${token}`]) {
          expect(scanSecrets(sample)).not.toBeNull();
          expect(redactSecrets(sample)).not.toContain(token.slice(0, 10));
        }
      }
    });


    test("random lowercase and lowercase/digit credentials cut by slashes are found (property, measured miss rates)", () => {
      let seed = 11;
      const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      const run = (alphabet: string, length: number, every: number, samples: number) => {
        let missed = 0;
        for (let i = 0; i < samples; i++) {
          let token = "";
          for (let j = 0; j < length; j++) token += (j > 0 && j % every === 0 ? "/" : "") + alphabet[Math.floor(next() * alphabet.length)];
          for (const sample of [`token ${token} x`, `see /api/${token}`]) {
            if (scanSecrets(sample) === null) missed++;
            else expect(redactSecrets(sample)).not.toContain(token.slice(0, 8));
          }
        }
        return missed / (samples * 2);
      };
      // 26 letters carry at most 4.7 bits a character, so some short random strings look like words; the bound is measured (about 4% to 6%).
      expect(run("abcdefghijklmnopqrstuvwxyz", 40, 9, 500)).toBeLessThan(0.1);
      expect(run("abcdefghijklmnopqrstuvwxyz", 36, 12, 500)).toBeLessThan(0.1);
      expect(run("abcdefghijklmnopqrstuvwxyz0123456789", 40, 9, 500)).toBeLessThan(0.005);
      expect(run("abcdefghijklmnopqrstuvwxyz0123456789", 34, 17, 500)).toBeLessThan(0.005);
    });


    test("a JWT whose signature ends in a base64url - or _ is still one whole jwt", () => {
      const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const payload = "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0";
      for (const signature of ["SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV-", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_", "Xy9-", "Qz7_-"]) {
        const token = `${header}.${payload}.${signature}`;
        for (const sample of [token, `Authorization: Bearer ${token}`, `jwt=${token} next`, `"${token}"`]) {
          expect(scanSecrets(sample)).not.toBeNull();
          const redacted = redactSecrets(sample);
          expect(redacted).not.toContain(header.slice(0, 12));
          expect(redacted).not.toContain(payload.slice(0, 12));
          expect(redacted).not.toContain(signature.slice(0, 12));
        }
        expect(scanSecrets(token)).toBe("jwt");
        expect(redactSecrets(`token ${token}`)).toBe("token [redacted]");
      }
    });

    test("a generic token needs the specified 4.0 bits a character, with or without a capital letter", () => {
      // 32 characters, about 3.70 bits a character, no capital letter, not an identifier shape: below the 4.0 the intent specifies.
      const repetitive = "aaaaaabbccddeeffgghhiijjkkllmmnn";
      for (const sample of [repetitive, `key ${repetitive} end`, `https://api.example.com/${repetitive}/send`, "z".repeat(40) + "yy"]) {
        expect(scanSecrets(sample)).toBeNull();
        expect(redactSecrets(sample)).toBe(sample);
      }
      // 4.0 and above still counts without a capital letter: 32 distinct lowercase/digit characters measure 5.0.
      const random = "qwertyuiopasdfghjklzxcvbnm012345";
      expect(scanSecrets(random)).not.toBeNull();
      expect(redactSecrets(`key ${random} end`)).not.toContain(random.slice(0, 10));
    });

    test("a hyphenated or camel-cased random credential is not an identifier", () => {
      for (const token of ["qavjklmn-wexrtypl-zibqwrst-fudghk", "qavjklmnWexrtyplZibqwrstFudghkbvc", "QAVJKLMN_WEXRTYPL_ZIBQWRST_FUDGHKXC"]) {
        expect(scanSecrets(token)).not.toBeNull();
        expect(redactSecrets(`key ${token} end`)).not.toContain(token.slice(0, 10));
      }
    });


    test("word-like pieces and tiny words do not make a credential an identifier or a path", () => {
      for (const token of [
        "abecidofu/ghijaklmn/oparistuv/xyzabecdf",
        "src/abecidofu/ghijaklmn/oparistuv/xyzabecdf",
        "api/src/lib/v1/abecidofu/ghijaklmn/oparistuv/xyzabecdf",
        "abecidofu/ghijaklmn/oparistuv/xyzabecdf/index",
        "qav-jkl-mnw-exr-typ-lzi-bqw-rst-fud-ghk",
        "qav_jkl_mnw_exr_typ_lzi_bqw_rst_fud_ghk",
        "QAV-JKL-MNW-EXR-TYP-LZI-BQW-RST-FUD-GHK",
        "qavJklMnwExrTypLziBqwRstFudGhkPvn",
      ]) {
        expect(scanSecrets(token)).not.toBeNull();
        expect(redactSecrets(`key ${token} end`)).not.toContain(token.slice(0, 8));
      }
    });


    test("a random lowercase-and-digit credential split by - or _ is not an identifier", () => {
      for (const token of ["6813ubb4-0w67kmep-p1hktma5-8vgseuug", "hq7tucy81rzsru8x_hpu0feaqgazriteu", "0u8rk56v09-i45m9ll7vi-612nchykz7-sikt89bspo"]) {
        for (const sample of [token, `key ${token} end`]) {
          expect(scanSecrets(sample)).not.toBeNull();
          expect(redactSecrets(sample)).not.toContain(token.slice(0, 8));
        }
      }
    });

    test("redaction removes the whole credential, including short lowercase slash fragments", () => {
      const core = "Kq9ZpL2mXv7RbT4nWc8YhJ1dFs6GaE3uQoN5";
      expect(redactSecrets(`url https://h/ab/${core}`)).toBe(`url https://[redacted]`);
      expect(redactSecrets(`url https://h/${core}/xy`)).toBe(`url https://[redacted]`);
      expect(redactSecrets(`url https://h/${core}/xyz/more`)).toBe(`url https://[redacted]`);
    });
  });
});
