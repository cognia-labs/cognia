---
"cognia-next": patch
---

Self-hosted deployments pull Cognia's images from ghcr.io/cognia-labs, where they are now published, and the docker proxy builds from source when its image is missing. A T2 host no longer sends the `default` workspace to a workspace runtime that only the remote-browser profile starts, and that runtime now shares the `default` folder the server and runners see.
