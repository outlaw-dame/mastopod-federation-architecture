# frozen_string_literal: true

persistent_timeout ENV.fetch("PERSISTENT_TIMEOUT", "20").to_i

max_threads_count = ENV.fetch("MAX_THREADS", "2").to_i
min_threads_count = ENV.fetch("MIN_THREADS", max_threads_count.to_s).to_i
threads min_threads_count, max_threads_count

bind "tcp://#{ENV.fetch("BIND", "0.0.0.0")}:#{ENV.fetch("PORT", "3000")}"
environment ENV.fetch("RAILS_ENV", "production")

# The local interop harness optimizes for low memory footprint and fast boot,
# not production throughput, so keep Puma in true single-process mode.
workers 0

plugin :tmp_restart
