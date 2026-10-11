# Security policy

This project currently targets DSH Desktop 0.2.0-rc.2 with Cordis 4.0.4. It adds checks within the supported DSH tool pipeline; it is not a process isolation boundary for malicious Node plugins or a guarantee of correct model judgments.

For suspected approval bypasses, credential exposure, or other security issues, use GitHub's **Report a vulnerability** action if private vulnerability reporting is enabled. Otherwise contact the maintainer privately through an available GitHub profile channel before sharing exploitation details. Do not place credentials or sensitive conversations in a public issue. This policy does not claim private reporting is enabled or promise a response time.

Include versions, a minimal synthetic reproduction, affected permission mode, and whether the effect occurred before or after a native approval. Redact credentials, account identifiers, personal file paths, and conversation content.

Credential rotation belongs in the provider account, followed by updating the local private file while review tasks are stopped. Never send a replacement key to the project maintainer.
