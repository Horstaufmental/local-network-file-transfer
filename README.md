# Local Network File Transfer

A project assignment (yet again), this time it's about HTTP-based local network file transferring (just like the name says)

It's supposed to be TCP, but more interesting to do a web based interface instead.

## Some core components

- Rust, the language being used for the backend
- Vite/React.ts, the framework for the web interface

## Building

Simply by statically building the web interface

```bash
# inside frontend/
npm run dev
```

Then build the backend

```bash
# inside the top-level directory
cargo build
```

Now simply just run.

```bash
cargo run
```

The port resides at `3000` with maximum input size of `1GiB`, which can be changed if `UPLOAD_LIMIT` environment variable is set
to a numeric string.

## Notes

This was, **severely rushed**. With the web interface completely handled by a LLM, and being pressured by 500 more assignments
with 5 days left until finals, this is just completely tiring. I absolutely hate it.
This year has not been good academically and I still have yet to create a report of this.

I also was planning to create a localized Thai translation but welp, name constraints.

Absolute bullshit.

## License

This project is proudly licensed under the **Apache License 2.0**, more can be found in [LICENSE](./LICENSE)
