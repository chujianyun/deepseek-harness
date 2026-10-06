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
