/**
 * 本地回环 HTTPS 测试夹具。
 *
 * 只用于 tests/run-tests.mjs 里 canonical 协议矩阵的真实 TLS 请求：
 * 证书是自签名的、绑定 127.0.0.1 / localhost，不是任何真实服务的凭据，
 * 也不会被 verify-deployment.mjs 或部署产物使用。子进程通过
 * NODE_EXTRA_CA_CERTS 信任这份证书（不关闭 TLS 校验、不需要 openssl 或第三方包）。
 *
 * 这样可以在不访问外网、不依赖额外工具的情况下，真正以 https:// 站点执行验收脚本，
 * 用来验证 canonical 的协议一致性判定（http canonical 不能算指向自身）。
 */

export const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgT8UQ94qQAVu9yLVY
D9R+kdrT50R0iXudh6v5vs6x/FuhRANCAATXRKNCy5GoK8vxdMNDyVkImU+6wcER
2LHMVPv5k9Fq03bm979tUDCEJIKkisyT1xv7Df5ByaIO0bmsstTKZmh1
-----END PRIVATE KEY-----
`;

export const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUDxv361JGm77x+TOA3juSdnn7mpowCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTExNDEwMTEyNFoYDzIxMjYxMDIx
MTAxMTI0WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATXRKNCy5GoK8vxdMNDyVkImU+6wcER2LHMVPv5k9Fq03bm979tUDCE
JIKkisyT1xv7Df5ByaIO0bmsstTKZmh1o28wbTAdBgNVHQ4EFgQUVdtyeB7GO23F
QiDJD7awlnBoDrcwHwYDVR0jBBgwFoAUVdtyeB7GO23FQiDJD7awlnBoDrcwGgYD
VR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZI
zj0EAwIDSQAwRgIhAIV5Xb+MvPpCJ/iNNfrU+kGwSBm8WCU1S48psHO+7oahAiEA
9kaxl4wVQGS/jfYtUcskQrChLlO6M6vl5fuqUx6cpbo=
-----END CERTIFICATE-----
`;
