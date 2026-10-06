/**
 * The CLI each supported connector installs. Sizes and sha256 digests are those the project
 * publishes in its release `checksums.txt`; deployments can restate them through the plugin
 * configuration.
 */
import type { CliSpec } from './index.ts'

/** Feishu: `lark-cli` 1.0.97 from larksuite/cli, as its npm installer fetches it (npmmirror, then GitHub releases). */
export const LARK_CLI: CliSpec = {
  binary: 'lark-cli',
  version: '1.0.97',
  mirrors: [
    'https://registry.npmmirror.com/-/binary/lark-cli/v{version}/{file}',
    'https://github.com/larksuite/cli/releases/download/v{version}/{file}',
  ],
  archives: [
    {
      platform: 'darwin-arm64', file: 'lark-cli-1.0.97-darwin-arm64.tar.gz', size: 13_964_426,
      sha256: '64e856a05c8dfdac5dbecd316766e4b05299f230f54833b674a623df3ac13f1c',
    },
    {
      platform: 'darwin-x64', file: 'lark-cli-1.0.97-darwin-amd64.tar.gz', size: 15_127_165,
      sha256: '1f5d3899138bc058662a027d0034ed69d21287d83322993afc01fee559b78de0',
    },
    {
      platform: 'linux-x64', file: 'lark-cli-1.0.97-linux-amd64.tar.gz', size: 14_373_571,
      sha256: '7ce11848724f0b0bc8204012140adbf76fe7c1fc8abd41c1878bc97b7228126b',
    },
    {
      platform: 'linux-arm64', file: 'lark-cli-1.0.97-linux-arm64.tar.gz', size: 13_240_765,
      sha256: '2dec3e362ecce05b535854a0205035bb4ccdb72dbbed9a321890c2089da16bc5',
    },
    {
      platform: 'win32-x64', file: 'lark-cli-1.0.97-windows-amd64.zip', size: 14_780_585,
      sha256: '88ee81ec73be12432b2297df010098b5069e5ff0403123e1cd308ad0061f1397',
    },
    {
      platform: 'win32-arm64', file: 'lark-cli-1.0.97-windows-arm64.zip', size: 13_382_844,
      sha256: '4fef85e999fc54de1234b0bb622766f096870db2b86a396545e01a4156abfb3b',
    },
  ],
}

/**
 * DingTalk: `dws` 1.0.63 from DingTalk-Real-AI/dingtalk-workspace-cli, from its GitHub release; npmmirror
 * serves only the npm package, which carries every platform's archive. Windows is left out: there `dws`
 * keeps sign-ins in the user's registry, which no per-tenant directory can isolate. The Skills ship
 * beside the executable as `dws-skills.zip`.
 */
export const DWS_CLI: CliSpec = {
  binary: 'dws',
  version: '1.0.63',
  mirrors: ['https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v{version}/{file}'],
  archives: [
    {
      platform: 'darwin-arm64', file: 'dws-darwin-arm64.tar.gz', size: 16_062_209,
      sha256: '7f57c3e4e141b9f0fd81a04f0298023a0855e1b6e02ad09c897e91e9c58bd5a9',
    },
    {
      platform: 'darwin-x64', file: 'dws-darwin-amd64.tar.gz', size: 17_627_332,
      sha256: '87added1a0b2b2192516283b210ae90ab3770f55518560243c3c1905824485ed',
    },
    {
      platform: 'linux-x64', file: 'dws-linux-amd64.tar.gz', size: 18_434_895,
      sha256: '78cab668bf671c17128ac55347627fb28f80c15b9c30c5f86e32e2b5ee6e34bc',
    },
    {
      platform: 'linux-arm64', file: 'dws-linux-arm64.tar.gz', size: 17_367_271,
      sha256: '14df04191b8d3826ca48a26be290eae65bd3fcc15e45fbb580ae1d1542b891fc',
    },
  ],
  skills: { file: 'dws-skills.zip', size: 3_251_120, sha256: '6a36e5a501fd8eb748702b1dedb33f93a166c0a88b459b6f982d926bfb8e150b' },
}
