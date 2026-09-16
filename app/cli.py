"""Local setup: python -m app.cli init. Does not contact Zerodha."""
import argparse
import getpass
import os
from pathlib import Path
import secrets

from argon2 import PasswordHasher
from cryptography.fernet import Fernet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["init", "hash-password"])
    parser.add_argument("--output", default=".env")
    args = parser.parse_args()
    if args.command == "init" and Path(args.output).exists():
        parser.error("Configuration already exists; edit it directly instead of overwriting credentials")
    username = input("Admin username [admin]: ").strip() or "admin" if args.command == "init" else "admin"
    password = getpass.getpass("Admin password (at least 14 characters): ")
    if len(password) < 14 or password != getpass.getpass("Confirm password: "):
        parser.error("Passwords must match and contain at least 14 characters")
    hashed = PasswordHasher().hash(password)
    if args.command == "hash-password":
        print(hashed)
        return
    if not username.replace("-", "").replace("_", "").isalnum() or len(username) > 128:
        parser.error("Use letters, digits, underscores or hyphens for the username")
    content = Path(__file__).resolve().parent.parent.joinpath(".env.example").read_text(encoding="utf-8")
    replacements = {"ADMIN_USERNAME": username, "ADMIN_PASSWORD_HASH": hashed, "SESSION_SECRET": secrets.token_urlsafe(48), "TOKEN_ENCRYPTION_KEY": Fernet.generate_key().decode()}
    lines = [f"{line.split('=', 1)[0]}='{replacements[line.split('=', 1)[0]]}'" if line.split('=', 1)[0] in replacements else line for line in content.splitlines()]
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
        output.write("\n".join(lines) + "\n")
    print(f"Created {args.output}. Add your Kite API credentials and client ID there, then run the server.")


if __name__ == "__main__":
    main()
