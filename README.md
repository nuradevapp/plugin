# Hacker Assist Plugin

Voice control for Claude Code — from your phone.
https://hackerassist.com

## Install

/plugin install hackerassist@marketplace.hackerassist.com

## Usage

claude --channels plugin:hackerassist@marketplace.hackerassist.com

A pairing code appears in your terminal.
Open https://app.hackerassist.com on your phone and enter the code.

## Research preview

Until the plugin is on Anthropic's approved allowlist, use:
claude --dangerously-load-development-channels plugin:hackerassist@marketplace.hackerassist.com

## Self-hosted relay

HACKER_ASSIST_RELAY_URL=wss://your-relay.example.com claude --channels ...
