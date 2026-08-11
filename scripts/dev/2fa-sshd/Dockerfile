# A throwaway sshd that authenticates the way institutional clusters do (#73):
# keyboard-interactive through PAM, asking for a password AND a one-time code.
# Neither maintainer has a 2FA cluster, so this is what the interactive sign-in
# is tested against.
#
#   docker build -t os-2fa-sshd scripts/dev/2fa-sshd
#   docker run -d --name os-2fa-test -p 2222:22 os-2fa-sshd
#   CODE=$(docker exec os-2fa-test oathtool --totp 3132333435363738393031323334353637383930)
#   cd apps/desktop/src-tauri && OS_SSH_TEST_HOST=tester@localhost \
#     OS_SSH_TEST_PORT=2222 OS_SSH_TEST_ANSWERS="pw-first-factor;$CODE" \
#     cargo test --lib shared_connection -- --ignored --nocapture
#   docker rm -f os-2fa-test
#
# Expect it to print both prompts verbatim, then "a client with no credentials
# rode it" — the property the whole feature rests on.

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server libpam-oath oathtool ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash tester && echo 'tester:pw-first-factor' | chpasswd && mkdir -p /run/sshd
# RFC 4226 test key, as a TOTP second factor.
RUN printf 'HOTP/T30/6 tester - 3132333435363738393031323334353637383930\n' > /etc/users.oath \
    && chmod 600 /etc/users.oath
# Two prompts in one keyboard-interactive exchange: the password, then the code.
RUN printf 'auth required pam_unix.so\nauth required pam_oath.so usersfile=/etc/users.oath window=20 digits=6\naccount required pam_unix.so\nsession required pam_unix.so\nsession required pam_loginuid.so\n' > /etc/pam.d/sshd
RUN printf 'KbdInteractiveAuthentication yes\nPasswordAuthentication no\nPubkeyAuthentication no\nUsePAM yes\nAuthenticationMethods keyboard-interactive\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/2fa.conf
CMD ["/usr/sbin/sshd","-D","-e"]
