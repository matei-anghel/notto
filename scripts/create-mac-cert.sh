#!/bin/bash
# Create a self-signed certificate for macOS code signing
# This allows consistent code signatures for auto-updates without a paid Apple Developer account

set -e

CERT_NAME="Notto Self-Signed"
CERT_PASS="notto-signing"

echo "🔐 Creating self-signed certificate for Notto..."

# Check if certificate already exists
if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
    echo "✅ Certificate '$CERT_NAME' already exists in keychain."
    echo ""
    echo "To use it, your electron-builder.yml should have:"
    echo "  mac:"
    echo "    identity: \"$CERT_NAME\""
    exit 0
fi

# Create a temporary directory for certificate files
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Generate private key
openssl genrsa -out "$TEMP_DIR/private.key" 2048

# Create certificate signing request
openssl req -new -key "$TEMP_DIR/private.key" \
    -out "$TEMP_DIR/cert.csr" \
    -subj "/CN=$CERT_NAME/O=Notto Inc./C=US"

# Create self-signed certificate (valid for 10 years)
openssl x509 -req -days 3650 \
    -in "$TEMP_DIR/cert.csr" \
    -signkey "$TEMP_DIR/private.key" \
    -out "$TEMP_DIR/cert.crt" \
    -extfile <(printf "keyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning")

# Convert to p12 format for keychain import
openssl pkcs12 -export \
    -out "$TEMP_DIR/cert.p12" \
    -inkey "$TEMP_DIR/private.key" \
    -in "$TEMP_DIR/cert.crt" \
    -passout pass:$CERT_PASS

# Import to keychain
echo "📥 Importing certificate to keychain (you may be prompted for your password)..."
security import "$TEMP_DIR/cert.p12" \
    -k ~/Library/Keychains/login.keychain-db \
    -P "$CERT_PASS" \
    -T /usr/bin/codesign \
    -T /usr/bin/security

# Set certificate to be trusted for code signing
echo "🔑 Updating keychain settings..."
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" ~/Library/Keychains/login.keychain-db 2>/dev/null || true

echo ""
echo "✅ Self-signed certificate '$CERT_NAME' created successfully!"
echo ""
echo "📋 Next steps:"
echo "1. Open Keychain Access"
echo "2. Find '$CERT_NAME' under 'login' keychain > 'My Certificates'"
echo "3. Double-click it > Trust > 'Always Trust' for code signing"
echo ""
echo "4. Update your electron-builder.yml to use this certificate:"
echo "   mac:"
echo "     identity: \"$CERT_NAME\""
echo ""
echo "⚠️  Note: This certificate is self-signed and only useful for:"
echo "   - Consistent code signatures (so auto-updates work)"
echo "   - Users will still need to run 'sudo spctl --add' once"
