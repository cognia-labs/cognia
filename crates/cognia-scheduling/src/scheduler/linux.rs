//! Linux systemd implementation
//!
//! Uses systemd user services and timers for task scheduling.

use async_trait::async_trait;
use log::{debug, error, info, warn};
use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use super::error::{Result, SchedulerError};
use super::service::{generate_task_name, now_iso, SystemScheduler, TASK_PREFIX};
use super::types::{
    derive_trigger_capabilities, validate_open_url, CreateSystemTaskInput, RunLevel,
    SchedulerCapabilities, SystemTask, SystemTaskAction, SystemTaskStatus, SystemTaskTrigger,
    SystemTriggerKind, TaskMetadataState, TaskRunResult, TranslationValidation, TriggerCapability,
};

/// Linux systemd scheduler implementation
pub struct LinuxScheduler {
    /// Whether systemctl is available
    available: bool,
    /// User systemd directory
    user_dir: PathBuf,
    /// Command every unit operation runs as `<command…> --user …`. Always
    /// `["systemctl"]` outside tests, which point it at a stub script.
    systemctl_command: Vec<String>,
}

impl LinuxScheduler {
    /// Create a new Linux scheduler instance
    pub fn new() -> Self {
        let available = Self::check_systemctl_available();
        let user_dir = Self::get_user_systemd_dir();

        info!(
            "Linux scheduler initialized: available={}, dir={:?}",
            available, user_dir
        );

        Self {
            available,
            user_dir,
            systemctl_command: vec!["systemctl".to_string()],
        }
    }

    /// Check if systemctl is available
    fn check_systemctl_available() -> bool {
        Command::new("systemctl")
            .arg("--user")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Get user systemd directory
    fn get_user_systemd_dir() -> PathBuf {
        Self::user_systemd_dir(
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
            std::env::var_os("HOME").map(PathBuf::from),
        )
    }

    fn user_systemd_dir(xdg_config_home: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
        xdg_config_home
            .map(|path| path.join("systemd").join("user"))
            .or_else(|| home.map(|path| path.join(".config").join("systemd").join("user")))
            .unwrap_or_else(|| PathBuf::from("/tmp"))
    }

    fn parse_effective_uid(status: &str) -> Option<u32> {
        status.lines().find_map(|line| {
            let mut fields = line.strip_prefix("Uid:")?.split_whitespace();
            fields.nth(1)?.parse().ok()
        })
    }

    /// Generate service unit name
    fn service_name(task_name: &str) -> String {
        format!("cognia-task-{}.service", Self::sanitize_name(task_name))
    }

    /// Generate timer unit name
    fn timer_name(task_name: &str) -> String {
        format!("cognia-task-{}.timer", Self::sanitize_name(task_name))
    }

    /// Sanitize name for systemd unit
    fn sanitize_name(name: &str) -> String {
        name.chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect()
    }

    /// Generate service unit content
    fn generate_service(task: &SystemTask) -> Result<String> {
        let (exec_start, working_dir, env) = Self::build_exec_start(&task.action)?;

        let mut unit = format!(
            r#"[Unit]
Description=Cognia Task: {}
After=network.target

[Service]
Type=oneshot
ExecStart={}
"#,
            task.name, exec_start
        );

        if let Some(dir) = working_dir {
            unit.push_str(&format!("WorkingDirectory={}\n", dir));
        }

        for (k, v) in env {
            unit.push_str(&format!("Environment=\"{}={}\"\n", k, v));
        }

        // Logging
        unit.push_str("StandardOutput=journal\n");
        unit.push_str("StandardError=journal\n");

        // Install section
        unit.push_str("\n[Install]\nWantedBy=default.target\n");

        Ok(unit)
    }

    /// Generate timer unit content. `unit_id` is the id the unit files are
    /// written under (`generate_task_name`), never the display name: `Unit=`
    /// must name the service file that actually exists.
    fn generate_timer(task: &SystemTask, unit_id: &str) -> Result<String> {
        let service_name = Self::service_name(unit_id);
        let on_calendar = Self::trigger_to_on_calendar(&task.trigger)?;

        let mut timer = format!(
            r#"[Unit]
Description=Timer for Cognia Task: {}

[Timer]
"#,
            task.name
        );

        let is_calendar_timer = match &task.trigger {
            SystemTaskTrigger::OnBoot { delay_seconds } => {
                timer.push_str(&format!("OnBootSec={}s\n", delay_seconds));
                false
            }
            SystemTaskTrigger::Interval { seconds } => {
                timer.push_str(&format!("OnUnitActiveSec={}s\n", seconds));
                timer.push_str("OnBootSec=60s\n"); // Start 60s after boot
                false
            }
            _ => {
                if let Some(cal) = on_calendar {
                    timer.push_str(&format!("OnCalendar={}\n", cal));
                    true
                } else {
                    false
                }
            }
        };

        // Persistent=true only meaningful for OnCalendar timers; systemd ignores it for monotonic timers
        if is_calendar_timer {
            timer.push_str("Persistent=true\n");
        }
        timer.push_str(&format!("Unit={}\n", service_name));
        timer.push_str("\n[Install]\nWantedBy=timers.target\n");

        Ok(timer)
    }

    /// Convert trigger to systemd OnCalendar format
    fn trigger_to_on_calendar(trigger: &SystemTaskTrigger) -> Result<Option<String>> {
        match trigger {
            SystemTaskTrigger::Cron { expression, .. } => {
                Self::cron_to_calendar(expression).map(Some)
            }
            SystemTaskTrigger::Once { run_at } => Self::once_on_calendar(run_at).map(Some),
            SystemTaskTrigger::OnLogon { .. } => {
                // Use OnStartupSec instead
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    /// The absolute instant of a one-time trigger as an `OnCalendar=` value.
    ///
    /// A bare `YYYY-MM-DD HH:MM:SS` is read by systemd in the HOST's timezone,
    /// so writing the input's wall clock without its offset moved the run by
    /// the difference (`09:00+08:00` became 09:00 local). The instant is
    /// converted to UTC and written with the `UTC` suffix systemd accepts in
    /// calendar specifications since v228, and a sub-second instant is rounded
    /// up to the next second so the timer never fires early.
    fn once_on_calendar(run_at: &str) -> Result<String> {
        let dt = chrono::DateTime::parse_from_rfc3339(run_at)
            .map_err(|e| SchedulerError::InvalidConfig(format!("Invalid datetime: {}", e)))?;
        let seconds = dt.timestamp() + i64::from(dt.timestamp_subsec_nanos() != 0);
        let utc = chrono::DateTime::from_timestamp(seconds, 0).ok_or_else(|| {
            SchedulerError::InvalidConfig("Datetime is outside the systemd range".to_string())
        })?;
        Ok(format!("{} UTC", utc.format("%Y-%m-%d %H:%M:%S")))
    }

    /// Convert cron expression to systemd calendar format
    fn cron_to_calendar(expression: &str) -> Result<String> {
        let parts: Vec<&str> = expression.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(SchedulerError::InvalidCron(format!(
                "Expected 5 parts, got {}",
                parts.len()
            )));
        }

        let (minute, hour, dom, month, dow) = (parts[0], parts[1], parts[2], parts[3], parts[4]);

        // Build systemd calendar format: DOW YEAR-MONTH-DAY HOUR:MINUTE:SECOND
        let mut calendar = String::new();

        // Day of week
        if dow != "*" {
            calendar.push_str(&Self::convert_dow_systemd(dow));
            calendar.push(' ');
        }

        // Date part (YEAR-MONTH-DAY)
        calendar.push_str("*-"); // Year is always *

        // Month
        if month == "*" {
            calendar.push_str("*-");
        } else {
            calendar.push_str(&format!("{}-", Self::expand_cron_field(month)));
        }

        // Day of month
        if dom == "*" {
            calendar.push_str("* ");
        } else {
            calendar.push_str(&format!("{} ", Self::expand_cron_field(dom)));
        }

        // Time part (HOUR:MINUTE:SECOND)
        // Hour
        if hour == "*" {
            calendar.push_str("*:");
        } else {
            calendar.push_str(&format!("{}:", Self::expand_cron_field(hour)));
        }

        // Minute
        if minute == "*" {
            calendar.push_str("*:00");
        } else {
            calendar.push_str(&format!("{}:00", Self::expand_cron_field(minute)));
        }

        Ok(calendar)
    }

    /// Expand cron field (handle */n syntax)
    fn expand_cron_field(field: &str) -> String {
        if let Some(step) = field.strip_prefix("*/") {
            // Convert */5 to 0/5 for systemd
            format!("0/{step}")
        } else {
            field.to_string()
        }
    }

    /// Convert cron day-of-week to systemd format
    fn convert_dow_systemd(dow: &str) -> String {
        if dow.contains('-') {
            // Range like 1-5
            let parts: Vec<&str> = dow.split('-').collect();
            if parts.len() == 2 {
                let start = Self::num_to_day_systemd(parts[0]);
                let end = Self::num_to_day_systemd(parts[1]);
                return format!("{}..{}", start, end);
            }
        }

        if dow.contains(',') {
            return dow
                .split(',')
                .map(Self::num_to_day_systemd)
                .collect::<Vec<_>>()
                .join(",");
        }

        Self::num_to_day_systemd(dow)
    }

    /// Convert numeric day to systemd day name
    fn num_to_day_systemd(day: &str) -> String {
        match day.parse::<u32>() {
            Ok(0) | Ok(7) => "Sun".to_string(),
            Ok(1) => "Mon".to_string(),
            Ok(2) => "Tue".to_string(),
            Ok(3) => "Wed".to_string(),
            Ok(4) => "Thu".to_string(),
            Ok(5) => "Fri".to_string(),
            Ok(6) => "Sat".to_string(),
            _ => day.to_string(),
        }
    }

    /// Build ExecStart command
    fn build_exec_start(
        action: &SystemTaskAction,
    ) -> Result<(String, Option<String>, HashMap<String, String>)> {
        match action {
            SystemTaskAction::ExecuteScript {
                language,
                code,
                working_dir,
                args,
                env,
                timeout_secs,
                memory_mb,
                use_sandbox,
            } => {
                let code_b64 =
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, code);
                let cognia_path = Self::get_cognia_path();
                let sandbox_flag = if *use_sandbox {
                    "--sandbox"
                } else {
                    "--native"
                };

                let exec_start = format!(
                    "{} execute-script --language {} {} --timeout {} --memory {} --code-b64 '{}' {}",
                    cognia_path,
                    language,
                    sandbox_flag,
                    timeout_secs,
                    memory_mb,
                    code_b64,
                    args.join(" ")
                );

                Ok((exec_start, working_dir.clone(), env.clone()))
            }
            SystemTaskAction::RunCommand {
                command,
                args,
                working_dir,
                env,
            } => {
                let exec_start = if args.is_empty() {
                    command.clone()
                } else {
                    format!("{} {}", command, args.join(" "))
                };

                Ok((exec_start, working_dir.clone(), env.clone()))
            }
            SystemTaskAction::LaunchApp { path, args } => {
                let exec_start = if args.is_empty() {
                    path.clone()
                } else {
                    format!("{} {}", path, args.join(" "))
                };

                Ok((exec_start, None, HashMap::new()))
            }
            SystemTaskAction::OpenUrl { url } => {
                validate_open_url(url).map_err(SchedulerError::InvalidConfig)?;
                // `xdg-open` hands the URL to the registered handler (the
                // Cognia desktop app for `cognia://`, the browser for https).
                // Absolute path: systemd < 239 rejects a bare program name in
                // `ExecStart=`. `validate_open_url` already rejects `%`, so
                // no specifier escaping is needed on the URL.
                Ok((format!("/usr/bin/xdg-open {}", url), None, HashMap::new()))
            }
        }
    }

    /// Get Cognia executable path
    fn get_cognia_path() -> String {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "/usr/bin/cognia".to_string())
    }

    fn parse_unit_value(content: &str, key: &str) -> Option<String> {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some(rest) = line.strip_prefix(&format!("{key}=")) {
                return Some(rest.trim().trim_matches('"').to_string());
            }
        }
        None
    }

    fn parse_duration_seconds(raw: &str) -> Option<u64> {
        let value = raw.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        if let Ok(seconds) = value.parse::<u64>() {
            return Some(seconds);
        }

        let regex = Regex::new(r"^(\d+)([a-z]+)$").ok()?;
        let captures = regex.captures(&value)?;
        let num = captures.get(1)?.as_str().parse::<u64>().ok()?;
        let unit = captures.get(2)?.as_str();
        match unit {
            "s" | "sec" | "secs" | "second" | "seconds" => Some(num),
            "m" | "min" | "mins" | "minute" | "minutes" => Some(num * 60),
            "h" | "hr" | "hour" | "hours" => Some(num * 3600),
            "d" | "day" | "days" => Some(num * 24 * 3600),
            _ => None,
        }
    }

    fn parse_oncalendar_to_trigger(value: &str) -> Option<SystemTaskTrigger> {
        let trimmed = value.trim();
        // A one-time timer: `… UTC` is what `once_on_calendar` writes. A bare
        // datetime is what systemd reads in the host timezone, so that is the
        // instant it will fire at, and the instant reported back.
        if let Some(utc) = trimmed.strip_suffix(" UTC") {
            if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(utc.trim(), "%Y-%m-%d %H:%M:%S") {
                return Some(SystemTaskTrigger::Once {
                    run_at: dt
                        .and_utc()
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                });
            }
        }
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
            use chrono::TimeZone;
            if let Some(local) = chrono::Local.from_local_datetime(&dt).earliest() {
                return Some(SystemTaskTrigger::Once {
                    run_at: local.to_rfc3339(),
                });
            }
        }

        let regex = Regex::new(r"(\d{1,2}):(\d{1,2}):00").ok()?;
        let captures = regex.captures(trimmed)?;
        let hour = captures.get(1)?.as_str().parse::<u32>().ok()?;
        let minute = captures.get(2)?.as_str().parse::<u32>().ok()?;
        let dow = if trimmed.starts_with("Mon")
            || trimmed.starts_with("Tue")
            || trimmed.starts_with("Wed")
            || trimmed.starts_with("Thu")
            || trimmed.starts_with("Fri")
            || trimmed.starts_with("Sat")
            || trimmed.starts_with("Sun")
        {
            let day = trimmed
                .split_whitespace()
                .next()
                .unwrap_or("*")
                .replace("..", "-")
                .replace("Sun", "0")
                .replace("Mon", "1")
                .replace("Tue", "2")
                .replace("Wed", "3")
                .replace("Thu", "4")
                .replace("Fri", "5")
                .replace("Sat", "6");
            day
        } else {
            "*".to_string()
        };

        Some(SystemTaskTrigger::Cron {
            expression: format!("{minute} {hour} * * {dow}"),
            timezone: Some("UTC".to_string()),
        })
    }

    fn parse_trigger_from_units(timer_content: &str) -> Option<SystemTaskTrigger> {
        if let Some(value) = Self::parse_unit_value(timer_content, "OnUnitActiveSec")
            .and_then(|v| Self::parse_duration_seconds(&v))
        {
            return Some(SystemTaskTrigger::Interval { seconds: value });
        }

        if let Some(value) = Self::parse_unit_value(timer_content, "OnBootSec")
            .and_then(|v| Self::parse_duration_seconds(&v))
        {
            return Some(SystemTaskTrigger::OnBoot {
                delay_seconds: value,
            });
        }

        let on_calendar = Self::parse_unit_value(timer_content, "OnCalendar")?;
        Self::parse_oncalendar_to_trigger(&on_calendar)
    }

    fn arg_value(args: &[String], key: &str) -> Option<String> {
        args.iter()
            .position(|arg| arg == key)
            .and_then(|index| args.get(index + 1).cloned())
    }

    fn parse_service_env(service_content: &str) -> HashMap<String, String> {
        let mut env = HashMap::new();
        for line in service_content.lines() {
            let line = line.trim();
            if let Some(value) = line.strip_prefix("Environment=") {
                let value = value.trim().trim_matches('"');
                if let Some((key, val)) = value.split_once('=') {
                    env.insert(key.to_string(), val.to_string());
                }
            }
        }
        env
    }

    fn parse_action_from_service(service_content: &str) -> Option<SystemTaskAction> {
        let exec = Self::parse_unit_value(service_content, "ExecStart")?;
        let mut parts = exec
            .split_whitespace()
            .map(|item| item.trim_matches('\'').trim_matches('"').to_string())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return None;
        }

        let command = parts.remove(0);
        let args = parts;
        let working_dir = Self::parse_unit_value(service_content, "WorkingDirectory");
        let env = Self::parse_service_env(service_content);

        if args.iter().any(|arg| arg == "execute-script") {
            let language =
                Self::arg_value(&args, "--language").unwrap_or_else(|| "unknown".to_string());
            let timeout_secs = Self::arg_value(&args, "--timeout")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(300);
            let memory_mb = Self::arg_value(&args, "--memory")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(512);
            let use_sandbox = args.iter().any(|arg| arg == "--sandbox");
            let code_b64 = Self::arg_value(&args, "--code-b64").unwrap_or_default();
            let code = if code_b64.is_empty() {
                String::new()
            } else {
                base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    code_b64.as_bytes(),
                )
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .unwrap_or_default()
            };

            return Some(SystemTaskAction::ExecuteScript {
                language,
                code,
                working_dir,
                args: vec![],
                env,
                timeout_secs,
                memory_mb,
                use_sandbox,
            });
        }

        Some(SystemTaskAction::RunCommand {
            command,
            args,
            working_dir,
            env,
        })
    }

    /// Run systemctl command
    fn systemctl(&self, args: &[&str]) -> std::io::Result<std::process::Output> {
        let (program, prefix) = self
            .systemctl_command
            .split_first()
            .ok_or_else(|| std::io::Error::other("no systemctl command configured"))?;
        Command::new(program)
            .args(prefix)
            .arg("--user")
            .args(args)
            .output()
    }

    /// The task a definition describes, written under `unit_id`.
    fn task_from_input(unit_id: &str, input: CreateSystemTaskInput) -> SystemTask {
        let mut task = SystemTask {
            id: unit_id.to_string(),
            name: input.name,
            description: input.description,
            trigger: input.trigger,
            action: input.action,
            run_level: input.run_level,
            status: SystemTaskStatus::Enabled,
            requires_admin: false,
            tags: input.tags,
            created_at: Some(now_iso()),
            updated_at: Some(now_iso()),
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        };
        task.requires_admin = task.check_requires_admin();
        task
    }

    /// Both unit files for `task`, written as `unit_id`. Pure: a definition
    /// that cannot be expressed fails here, before anything on disk or in
    /// systemd is touched.
    fn render_units(task: &SystemTask, unit_id: &str) -> Result<(String, String)> {
        Ok((
            Self::generate_service(task)?,
            Self::generate_timer(task, unit_id)?,
        ))
    }

    /// Write both units, reload, and enable + start the timer.
    fn install_units(&self, unit_id: &str, service: &str, timer: &str) -> Result<()> {
        let timer_name = Self::timer_name(unit_id);
        fs::write(self.user_dir.join(Self::service_name(unit_id)), service)?;
        fs::write(self.user_dir.join(&timer_name), timer)?;
        debug!("Wrote units for {}", unit_id);
        self.daemon_reload()?;
        let output = self.systemctl(&["enable", "--now", &timer_name])?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Failed to enable timer: {}", stderr);
            return Err(SchedulerError::Platform(stderr.to_string()));
        }
        Ok(())
    }

    fn read_if_exists(path: &std::path::Path) -> Result<Option<Vec<u8>>> {
        match fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Put a unit file back the way it was: its old bytes, or absent.
    fn restore_file(path: &std::path::Path, previous: Option<&[u8]>) {
        let restored = match previous {
            Some(bytes) => fs::write(path, bytes),
            None => match fs::remove_file(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                other => other,
            },
        };
        if let Err(e) = restored {
            error!("Failed to restore {:?} after a failed update: {}", path, e);
        }
    }

    /// Replace the definition of the task already written as `unit_id`.
    ///
    /// The previous unit files are kept in memory until the new pair is
    /// written, reloaded and enabled; any failure on the way puts the old
    /// pair back (and re-enables it when it was enabled), so a failed update
    /// leaves the task exactly as it was instead of deleting it.
    fn replace_units(&self, unit_id: &str, service: &str, timer: &str) -> Result<()> {
        let service_path = self.user_dir.join(Self::service_name(unit_id));
        let timer_path = self.user_dir.join(Self::timer_name(unit_id));
        let timer_name = Self::timer_name(unit_id);
        let previous_service = Self::read_if_exists(&service_path)?;
        let previous_timer = Self::read_if_exists(&timer_path)?;
        let was_enabled = previous_timer.is_some()
            && self
                .systemctl(&["is-enabled", &timer_name])
                .map(|output| output.status.success())
                .unwrap_or(false);
        let _ = self.systemctl(&["disable", "--now", &timer_name]);
        if let Err(error) = self.install_units(unit_id, service, timer) {
            Self::restore_file(&service_path, previous_service.as_deref());
            Self::restore_file(&timer_path, previous_timer.as_deref());
            if let Err(reload) = self.daemon_reload() {
                error!("Reload after restoring {} failed: {}", unit_id, reload);
            }
            if was_enabled {
                let _ = self.systemctl(&["enable", "--now", &timer_name]);
            }
            return Err(error);
        }
        Ok(())
    }

    fn units_exist(&self, unit_id: &str) -> bool {
        self.unit_exists(&Self::service_name(unit_id))
            || self.unit_exists(&Self::timer_name(unit_id))
    }

    /// Check if a unit exists
    fn unit_exists(&self, unit_name: &str) -> bool {
        self.user_dir.join(unit_name).exists()
    }

    /// Reload systemd daemon
    fn daemon_reload(&self) -> Result<()> {
        let output = self.systemctl(&["daemon-reload"])?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(SchedulerError::Platform(format!(
                "daemon-reload failed: {}",
                stderr
            )));
        }
        Ok(())
    }
}

impl Default for LinuxScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SystemScheduler for LinuxScheduler {
    fn capabilities(&self) -> SchedulerCapabilities {
        let trigger_caps = self.get_trigger_capabilities();
        let supported_triggers = trigger_caps
            .iter()
            .filter(|tc| tc.available)
            .map(|tc| tc.trigger_type.clone())
            .collect();
        SchedulerCapabilities {
            os: "linux".to_string(),
            backend: "systemd".to_string(),
            available: self.available,
            can_elevate: false, // User services only
            supported_triggers,
            trigger_capabilities: trigger_caps,
            supported_actions: super::types::all_action_kinds(),
            max_tasks: 0,
        }
    }

    fn is_available(&self) -> bool {
        self.available
    }

    async fn create_task(&self, input: CreateSystemTaskInput) -> Result<SystemTask> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "systemd not available".to_string(),
            ));
        }

        // Ensure directory exists
        fs::create_dir_all(&self.user_dir)?;

        let task_name = generate_task_name(&input.name);

        // Check if already exists
        if self.units_exist(&task_name) {
            return Err(SchedulerError::TaskAlreadyExists(task_name));
        }

        let task = Self::task_from_input(&task_name, input);
        let (service_content, timer_content) = Self::render_units(&task, &task_name)?;
        if let Err(error) = self.install_units(&task_name, &service_content, &timer_content) {
            // Nothing of this task existed before; leave nothing behind.
            let _ = fs::remove_file(self.user_dir.join(Self::service_name(&task_name)));
            let _ = fs::remove_file(self.user_dir.join(Self::timer_name(&task_name)));
            let _ = self.daemon_reload();
            return Err(error);
        }

        info!("Created Linux task: {}", task_name);
        Ok(task)
    }

    /// Update a task without ever losing it (F11).
    ///
    /// Deleting first and then creating lost the original whenever the create
    /// failed: a rename onto an occupied name, a definition systemd refused.
    /// The new definition is rendered before anything is touched. A rename
    /// creates the new pair first (`create_task` refuses an occupied id before
    /// writing) and only then retires the old one; a same-id update replaces
    /// the pair in place and restores it on failure.
    async fn update_task(&self, id: &str, input: CreateSystemTaskInput) -> Result<SystemTask> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "systemd not available".to_string(),
            ));
        }

        let new_id = generate_task_name(&input.name);
        if Self::sanitize_name(&new_id) != Self::sanitize_name(id) {
            let created = self.create_task(input).await?;
            if let Err(error) = self.delete_task(id).await {
                if self.units_exist(id) {
                    // The old task is still there: withdraw the new one so the
                    // update leaves exactly the definition it started from.
                    if let Err(rollback) = self.delete_task(&created.id).await {
                        error!(
                            "Could not withdraw {} after failing to retire {}: {}",
                            created.id, id, rollback
                        );
                    }
                    return Err(error);
                }
                warn!(
                    "Renamed {} to {}; retiring the old units reported: {}",
                    id, created.id, error
                );
            }
            return Ok(created);
        }

        fs::create_dir_all(&self.user_dir)?;
        let task = Self::task_from_input(id, input);
        let (service_content, timer_content) = Self::render_units(&task, id)?;
        self.replace_units(id, &service_content, &timer_content)?;
        info!("Updated Linux task: {}", id);
        Ok(task)
    }

    async fn delete_task(&self, id: &str) -> Result<bool> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "systemd not available".to_string(),
            ));
        }

        let service_name = Self::service_name(id);
        let timer_name = Self::timer_name(id);

        // Stop and disable timer
        let _ = self.systemctl(&["disable", "--now", &timer_name]);

        // Remove unit files
        let service_path = self.user_dir.join(&service_name);
        let timer_path = self.user_dir.join(&timer_name);

        let mut deleted = false;

        if service_path.exists() {
            fs::remove_file(&service_path)?;
            deleted = true;
        }

        if timer_path.exists() {
            fs::remove_file(&timer_path)?;
            deleted = true;
        }

        if deleted {
            self.daemon_reload()?;
            info!("Deleted Linux task: {}", id);
        }

        Ok(deleted)
    }

    async fn get_task(&self, id: &str) -> Result<Option<SystemTask>> {
        let timer_name = Self::timer_name(id);
        let service_name = Self::service_name(id);

        if !self.unit_exists(&timer_name) {
            return Ok(None);
        }

        // Get status
        let output = self.systemctl(&["is-active", &timer_name])?;
        let status = if output.status.success() {
            SystemTaskStatus::Enabled
        } else {
            SystemTaskStatus::Disabled
        };

        let timer_content = fs::read_to_string(self.user_dir.join(&timer_name)).unwrap_or_default();
        let service_content =
            fs::read_to_string(self.user_dir.join(&service_name)).unwrap_or_default();
        let parsed_trigger = Self::parse_trigger_from_units(&timer_content);
        let parsed_action = Self::parse_action_from_service(&service_content);
        let metadata_state = if parsed_trigger.is_some() && parsed_action.is_some() {
            TaskMetadataState::Full
        } else {
            TaskMetadataState::Degraded
        };

        Ok(Some(SystemTask {
            id: id.to_string(),
            name: id.trim_start_matches(TASK_PREFIX).to_string(),
            description: None,
            trigger: parsed_trigger.unwrap_or(SystemTaskTrigger::Interval { seconds: 0 }),
            action: parsed_action.unwrap_or(SystemTaskAction::RunCommand {
                command: String::new(),
                args: vec![],
                working_dir: None,
                env: HashMap::new(),
            }),
            run_level: RunLevel::User,
            status,
            requires_admin: false,
            tags: vec![],
            created_at: None,
            updated_at: None,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state,
        }))
    }

    async fn list_tasks(&self) -> Result<Vec<SystemTask>> {
        if !self.available || !self.user_dir.exists() {
            return Ok(vec![]);
        }

        let mut tasks = Vec::new();

        for entry in fs::read_dir(&self.user_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();

            if name.starts_with("cognia-task-") && name.ends_with(".timer") {
                let id = name
                    .trim_start_matches("cognia-task-")
                    .trim_end_matches(".timer")
                    .to_string();

                if let Ok(Some(task)) = self.get_task(&id).await {
                    tasks.push(task);
                }
            }
        }

        Ok(tasks)
    }

    async fn enable_task(&self, id: &str) -> Result<bool> {
        let timer_name = Self::timer_name(id);
        let output = self.systemctl(&["enable", "--now", &timer_name])?;
        Ok(output.status.success())
    }

    async fn disable_task(&self, id: &str) -> Result<bool> {
        let timer_name = Self::timer_name(id);
        let output = self.systemctl(&["disable", "--now", &timer_name])?;
        Ok(output.status.success())
    }

    async fn run_task_now(&self, id: &str) -> Result<TaskRunResult> {
        let service_name = Self::service_name(id);
        let start = std::time::Instant::now();

        let output = self.systemctl(&["start", &service_name])?;
        let duration_ms = start.elapsed().as_millis() as u64;

        Ok(TaskRunResult {
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout: Some(String::from_utf8_lossy(&output.stdout).to_string()),
            stderr: Some(String::from_utf8_lossy(&output.stderr).to_string()),
            error: if output.status.success() {
                None
            } else {
                Some(String::from_utf8_lossy(&output.stderr).to_string())
            },
            duration_ms: Some(duration_ms),
        })
    }

    fn requires_admin(&self, task: &SystemTask) -> bool {
        task.check_requires_admin()
    }

    async fn request_elevation(&self) -> Result<bool> {
        // User services don't need elevation
        Ok(true)
    }

    fn is_elevated(&self) -> bool {
        fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| Self::parse_effective_uid(&status))
            == Some(0)
    }

    fn get_trigger_capabilities(&self) -> Vec<TriggerCapability> {
        derive_trigger_capabilities(|kind| {
            match kind {
            SystemTriggerKind::Cron => (true, false, vec![], vec!["Uses systemd OnCalendar directive. Persistent=true ensures missed runs are caught up.".to_string()]),
            SystemTriggerKind::Interval => (true, false, vec![], vec!["Uses systemd OnUnitActiveSec. First run triggered 60s after boot via OnBootSec.".to_string()]),
            SystemTriggerKind::Once => (true, false, vec![], vec!["Uses systemd OnCalendar with a fixed datetime. Persistent=true ensures the run happens even if missed.".to_string()]),
            SystemTriggerKind::OnBoot => (true, false, vec![], vec!["Uses systemd OnBootSec. Runs as a user service after the user's systemd instance starts.".to_string()]),
            SystemTriggerKind::OnLogon => (false, false, vec!["systemd user services start at user login automatically; use 'on_boot' with a short delay for equivalent behavior.".to_string()], vec![]),
            SystemTriggerKind::OnEvent => (false, false, vec!["Event-based triggers are not supported via systemd user timers.".to_string()], vec![]),
        }
        })
    }

    fn validate_trigger_translation(&self, trigger: &SystemTaskTrigger) -> TranslationValidation {
        match trigger {
            SystemTaskTrigger::OnEvent { .. } => TranslationValidation {
                valid: false,
                errors: vec![
                    "Event-based triggers are not supported via systemd user timers.".to_string(),
                ],
                warnings: vec![],
                native_representation: None,
            },
            SystemTaskTrigger::OnLogon { .. } => TranslationValidation {
                valid: false,
                errors: vec![
                    "systemd user services start at user login automatically; use 'on_boot' with a short delay for equivalent behavior.".to_string(),
                ],
                warnings: vec![],
                native_representation: None,
            },
            SystemTaskTrigger::Cron { expression, .. } => {
                match Self::cron_to_calendar(expression) {
                    Ok(cal) => TranslationValidation {
                        valid: true,
                        errors: vec![],
                        warnings: vec![],
                        native_representation: Some(format!("systemd: OnCalendar={}", cal)),
                    },
                    Err(e) => TranslationValidation {
                        valid: false,
                        errors: vec![format!(
                            "Cron expression cannot be converted to systemd OnCalendar: {}",
                            e
                        )],
                        warnings: vec![],
                        native_representation: None,
                    },
                }
            }
            SystemTaskTrigger::Interval { seconds } => TranslationValidation {
                valid: true,
                errors: vec![],
                warnings: vec![],
                native_representation: Some(format!("systemd: OnUnitActiveSec={}s", seconds)),
            },
            SystemTaskTrigger::Once { run_at } => match Self::once_on_calendar(run_at) {
                Ok(calendar) => TranslationValidation {
                    valid: true,
                    errors: vec![],
                    warnings: vec![],
                    native_representation: Some(format!("systemd: OnCalendar={}", calendar)),
                },
                Err(e) => TranslationValidation {
                    valid: false,
                    errors: vec![e.to_string()],
                    warnings: vec![],
                    native_representation: None,
                },
            },
            SystemTaskTrigger::OnBoot { delay_seconds } => TranslationValidation {
                valid: true,
                errors: vec![],
                warnings: vec![],
                native_representation: Some(format!("systemd: OnBootSec={}s", delay_seconds)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_url_translates_to_xdg_open_and_rejects_bad_schemes() {
        let (exec_start, working_dir, env) =
            LinuxScheduler::build_exec_start(&SystemTaskAction::OpenUrl {
                url: "cognia://scheduler/task/abc?run=tok".to_string(),
            })
            .unwrap();
        assert_eq!(
            exec_start,
            "/usr/bin/xdg-open cognia://scheduler/task/abc?run=tok"
        );
        assert!(working_dir.is_none());
        assert!(env.is_empty());
        let err = LinuxScheduler::build_exec_start(&SystemTaskAction::OpenUrl {
            url: "cognia://a b".to_string(),
        })
        .unwrap_err();
        assert!(matches!(err, SchedulerError::InvalidConfig(_)));
        // `%` is a systemd specifier — refused before it can reach the unit.
        let err = LinuxScheduler::build_exec_start(&SystemTaskAction::OpenUrl {
            url: "cognia://a%h".to_string(),
        })
        .unwrap_err();
        assert!(matches!(err, SchedulerError::InvalidConfig(_)));
    }

    #[test]
    fn resolves_user_systemd_directory_from_linux_environment() {
        assert_eq!(
            LinuxScheduler::user_systemd_dir(
                Some(PathBuf::from("/xdg")),
                Some(PathBuf::from("/home/user")),
            ),
            PathBuf::from("/xdg/systemd/user")
        );
        assert_eq!(
            LinuxScheduler::user_systemd_dir(None, Some(PathBuf::from("/home/user"))),
            PathBuf::from("/home/user/.config/systemd/user")
        );
        assert_eq!(
            LinuxScheduler::user_systemd_dir(None, None),
            PathBuf::from("/tmp")
        );
    }

    #[test]
    fn parses_effective_uid_from_proc_status() {
        assert_eq!(
            LinuxScheduler::parse_effective_uid("Name:\tcognia\nUid:\t1000\t0\t1000\t1000\n"),
            Some(0)
        );
        assert_eq!(LinuxScheduler::parse_effective_uid("Name:\tcognia\n"), None);
    }

    #[test]
    fn parses_systemd_units_for_trigger_and_action() {
        let timer = r#"
[Timer]
OnUnitActiveSec=120s
"#;
        let service = r#"
[Service]
ExecStart=/bin/echo hello world
WorkingDirectory=/tmp
"#;

        let trigger = LinuxScheduler::parse_trigger_from_units(timer).expect("trigger");
        let action = LinuxScheduler::parse_action_from_service(service).expect("action");

        assert!(matches!(
            trigger,
            SystemTaskTrigger::Interval { seconds: 120 }
        ));
        assert!(matches!(action, SystemTaskAction::RunCommand { .. }));
    }

    #[test]
    fn timer_generation_uses_persistent_only_for_calendar() {
        let cron_task = SystemTask {
            id: "test-cron".to_string(),
            name: "cron-task".to_string(),
            description: None,
            trigger: SystemTaskTrigger::Cron {
                expression: "0 9 * * *".to_string(),
                timezone: None,
            },
            action: SystemTaskAction::RunCommand {
                command: "/bin/echo".to_string(),
                args: vec![],
                working_dir: None,
                env: HashMap::new(),
            },
            run_level: RunLevel::User,
            status: SystemTaskStatus::Enabled,
            requires_admin: false,
            tags: vec![],
            created_at: None,
            updated_at: None,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        };

        let timer = LinuxScheduler::generate_timer(&cron_task, "test-cron").expect("cron timer");
        assert!(
            timer.contains("Persistent=true"),
            "Calendar timer must have Persistent=true"
        );

        let interval_task = SystemTask {
            trigger: SystemTaskTrigger::Interval { seconds: 300 },
            ..cron_task.clone()
        };
        let timer =
            LinuxScheduler::generate_timer(&interval_task, "test-cron").expect("interval timer");
        assert!(
            !timer.contains("Persistent=true"),
            "Interval timer must NOT have Persistent=true"
        );

        let boot_task = SystemTask {
            trigger: SystemTaskTrigger::OnBoot { delay_seconds: 60 },
            ..cron_task
        };
        let timer = LinuxScheduler::generate_timer(&boot_task, "test-cron").expect("boot timer");
        assert!(
            !timer.contains("Persistent=true"),
            "OnBoot timer must NOT have Persistent=true"
        );
    }

    #[test]
    fn trigger_capabilities_report_on_logon_unavailable() {
        let scheduler = LinuxScheduler {
            available: true,
            user_dir: std::path::PathBuf::from("/tmp"),
            systemctl_command: vec!["systemctl".to_string()],
        };
        let caps = scheduler.get_trigger_capabilities();
        let on_logon = caps.iter().find(|c| c.trigger_type == "on_logon").unwrap();
        assert!(!on_logon.available);
    }

    #[test]
    fn validate_translation_rejects_on_logon() {
        let scheduler = LinuxScheduler {
            available: true,
            user_dir: std::path::PathBuf::from("/tmp"),
            systemctl_command: vec!["systemctl".to_string()],
        };
        let result =
            scheduler.validate_trigger_translation(&SystemTaskTrigger::OnLogon { user: None });
        assert!(!result.valid);
        assert!(!result.errors.is_empty());
    }

    fn command_input(name: &str, message: &str) -> CreateSystemTaskInput {
        CreateSystemTaskInput {
            name: name.to_string(),
            description: None,
            trigger: SystemTaskTrigger::Interval { seconds: 3600 },
            action: SystemTaskAction::RunCommand {
                command: "/bin/echo".to_string(),
                args: vec![message.to_string()],
                working_dir: None,
                env: HashMap::new(),
            },
            run_level: RunLevel::User,
            tags: vec![],
        }
    }

    /// A scheduler over a temporary unit directory whose `systemctl` is a
    /// shell script: it logs every call and then runs `body` (which may
    /// `exit 1` to fail a call). The script is run through `/bin/sh` rather
    /// than exec'd, so a freshly written file is never executed directly.
    fn stub_scheduler(dir: &std::path::Path, body: &str) -> (LinuxScheduler, PathBuf) {
        let units = dir.join("units");
        fs::create_dir_all(&units).unwrap();
        let log = dir.join("systemctl.log");
        let script = dir.join("systemctl.sh");
        fs::write(
            &script,
            format!(
                "echo \"$@\" >> '{}'\nUNITS='{}'\n{}\nexit 0\n",
                log.display(),
                units.display(),
                body
            ),
        )
        .unwrap();
        let scheduler = LinuxScheduler {
            available: true,
            user_dir: units,
            systemctl_command: vec!["/bin/sh".to_string(), script.display().to_string()],
        };
        (scheduler, log)
    }

    fn unit_bytes(scheduler: &LinuxScheduler, id: &str) -> (Vec<u8>, Vec<u8>) {
        (
            fs::read(scheduler.user_dir.join(LinuxScheduler::service_name(id))).unwrap(),
            fs::read(scheduler.user_dir.join(LinuxScheduler::timer_name(id))).unwrap(),
        )
    }

    #[tokio::test]
    async fn timer_unit_names_the_service_file_create_writes() {
        // F8: `Unit=` was built from the display name ("daily") while the
        // files are written under the generated id ("Cognia_daily").
        let dir = tempfile::tempdir().unwrap();
        let (scheduler, _log) = stub_scheduler(dir.path(), "");
        for name in ["daily", "Morning report: v2!"] {
            let task = scheduler
                .create_task(command_input(name, "hello"))
                .await
                .unwrap();
            assert_eq!(task.id, generate_task_name(name));
            let timer = fs::read_to_string(
                scheduler
                    .user_dir
                    .join(LinuxScheduler::timer_name(&task.id)),
            )
            .unwrap();
            let unit = LinuxScheduler::parse_unit_value(&timer, "Unit").expect("Unit=");
            assert_eq!(unit, LinuxScheduler::service_name(&task.id), "{name}");
            assert!(
                scheduler.user_dir.join(&unit).exists(),
                "{name}: Unit={unit} names no file"
            );
        }
    }

    #[test]
    fn once_calendar_keeps_the_absolute_instant() {
        // F9: the input's wall clock used to be written without its offset,
        // which systemd then reads in the host timezone.
        assert_eq!(
            LinuxScheduler::once_on_calendar("2026-11-18T09:00:00+08:00").unwrap(),
            "2026-11-18 01:00:00 UTC"
        );
        // A sub-second instant rounds up, never early.
        assert_eq!(
            LinuxScheduler::once_on_calendar("2026-11-18T01:00:00.250Z").unwrap(),
            "2026-11-18 01:00:01 UTC"
        );
        assert!(matches!(
            LinuxScheduler::once_on_calendar("tomorrow at nine"),
            Err(SchedulerError::InvalidConfig(_))
        ));

        let task = LinuxScheduler::task_from_input(
            "Cognia_once",
            CreateSystemTaskInput {
                trigger: SystemTaskTrigger::Once {
                    run_at: "2026-11-18T09:00:00+08:00".to_string(),
                },
                ..command_input("once", "hello")
            },
        );
        let timer = LinuxScheduler::generate_timer(&task, "Cognia_once").unwrap();
        assert!(
            timer.contains("OnCalendar=2026-11-18 01:00:00 UTC\n"),
            "{timer}"
        );

        let scheduler = LinuxScheduler {
            available: true,
            user_dir: PathBuf::from("/tmp"),
            systemctl_command: vec!["systemctl".to_string()],
        };
        let validation = scheduler.validate_trigger_translation(&SystemTaskTrigger::Once {
            run_at: "2026-11-18T09:00:00+08:00".to_string(),
        });
        assert_eq!(
            validation.native_representation.as_deref(),
            Some("systemd: OnCalendar=2026-11-18 01:00:00 UTC")
        );
    }

    #[test]
    fn once_calendar_round_trips_as_the_same_instant() {
        let instant = |run_at: &str| chrono::DateTime::parse_from_rfc3339(run_at).unwrap();
        let written = LinuxScheduler::once_on_calendar("2026-11-18T09:00:00+08:00").unwrap();
        match LinuxScheduler::parse_oncalendar_to_trigger(&written) {
            Some(SystemTaskTrigger::Once { run_at }) => assert_eq!(
                instant(&run_at).timestamp(),
                instant("2026-11-18T09:00:00+08:00").timestamp()
            ),
            other => panic!("expected a one-time trigger, got {other:?}"),
        }
        // A bare datetime is what systemd fires in the host timezone.
        use chrono::TimeZone;
        let naive = chrono::NaiveDate::from_ymd_opt(2026, 11, 18)
            .unwrap()
            .and_hms_opt(9, 0, 0)
            .unwrap();
        let expected = chrono::Local
            .from_local_datetime(&naive)
            .earliest()
            .unwrap()
            .timestamp();
        match LinuxScheduler::parse_oncalendar_to_trigger("2026-11-18 09:00:00") {
            Some(SystemTaskTrigger::Once { run_at }) => {
                assert_eq!(instant(&run_at).timestamp(), expected)
            }
            other => panic!("expected a one-time trigger, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rename_onto_an_occupied_task_keeps_the_original() {
        // F11: update used to delete the original before the create failed.
        let dir = tempfile::tempdir().unwrap();
        let (scheduler, _log) = stub_scheduler(dir.path(), "");
        let original = scheduler
            .create_task(command_input("original-a", "a"))
            .await
            .unwrap();
        let occupied = scheduler
            .create_task(command_input("occupied-b", "b"))
            .await
            .unwrap();
        let original_units = unit_bytes(&scheduler, &original.id);
        let occupied_units = unit_bytes(&scheduler, &occupied.id);

        let result = scheduler
            .update_task(&original.id, command_input("occupied-b", "renamed"))
            .await;

        assert!(matches!(result, Err(SchedulerError::TaskAlreadyExists(_))));
        assert_eq!(unit_bytes(&scheduler, &original.id), original_units);
        assert_eq!(unit_bytes(&scheduler, &occupied.id), occupied_units);
    }

    #[tokio::test]
    async fn rename_creates_the_new_task_before_retiring_the_old() {
        let dir = tempfile::tempdir().unwrap();
        let (scheduler, log) = stub_scheduler(dir.path(), "");
        let original = scheduler
            .create_task(command_input("original-a", "a"))
            .await
            .unwrap();
        fs::write(&log, "").unwrap();

        let renamed = scheduler
            .update_task(&original.id, command_input("renamed", "a"))
            .await
            .unwrap();

        assert_eq!(renamed.id, generate_task_name("renamed"));
        assert!(scheduler.units_exist(&renamed.id));
        assert!(!scheduler.units_exist(&original.id));
        let calls = fs::read_to_string(&log).unwrap();
        let enabled_new = calls
            .find(&format!(
                "enable --now {}",
                LinuxScheduler::timer_name(&renamed.id)
            ))
            .expect("new timer enabled");
        let disabled_old = calls
            .find(&format!(
                "disable --now {}",
                LinuxScheduler::timer_name(&original.id)
            ))
            .expect("old timer disabled");
        assert!(enabled_new < disabled_old, "{calls}");
    }

    #[tokio::test]
    async fn failed_same_id_update_restores_the_previous_definition() {
        let dir = tempfile::tempdir().unwrap();
        // systemd refuses to enable any definition that runs NEWDEF.
        let (scheduler, log) = stub_scheduler(
            dir.path(),
            "if [ \"$2\" = enable ] && grep -q NEWDEF \"$UNITS\"/*.service; then exit 1; fi",
        );
        let task = scheduler
            .create_task(command_input("keep", "old"))
            .await
            .unwrap();
        let before = unit_bytes(&scheduler, &task.id);

        let result = scheduler
            .update_task(&task.id, command_input("keep", "NEWDEF"))
            .await;

        assert!(matches!(result, Err(SchedulerError::Platform(_))));
        assert_eq!(unit_bytes(&scheduler, &task.id), before);
        let calls = fs::read_to_string(&log).unwrap();
        assert!(
            calls.trim_end().ends_with(&format!(
                "--user enable --now {}",
                LinuxScheduler::timer_name(&task.id)
            )),
            "the restored timer is enabled again: {calls}"
        );
    }

    #[tokio::test]
    async fn invalid_definition_never_touches_the_existing_task() {
        let dir = tempfile::tempdir().unwrap();
        let (scheduler, log) = stub_scheduler(dir.path(), "");
        let task = scheduler
            .create_task(command_input("keep", "old"))
            .await
            .unwrap();
        let before = unit_bytes(&scheduler, &task.id);
        fs::write(&log, "").unwrap();

        let result = scheduler
            .update_task(
                &task.id,
                CreateSystemTaskInput {
                    action: SystemTaskAction::OpenUrl {
                        url: "javascript://x".to_string(),
                    },
                    ..command_input("keep", "old")
                },
            )
            .await;

        assert!(matches!(result, Err(SchedulerError::InvalidConfig(_))));
        assert_eq!(unit_bytes(&scheduler, &task.id), before);
        assert_eq!(fs::read_to_string(&log).unwrap(), "", "systemd was touched");
    }

    #[tokio::test]
    async fn same_id_update_replaces_the_definition_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let (scheduler, _log) = stub_scheduler(dir.path(), "");
        let task = scheduler
            .create_task(command_input("keep", "old"))
            .await
            .unwrap();
        let listed_id = task.id.to_lowercase();

        let updated = scheduler
            .update_task(&listed_id, command_input("keep", "new"))
            .await
            .unwrap();

        // The id the caller holds survives: it names the same unit pair.
        assert_eq!(updated.id, listed_id);
        let service = fs::read_to_string(
            scheduler
                .user_dir
                .join(LinuxScheduler::service_name(&task.id)),
        )
        .unwrap();
        assert!(service.contains("ExecStart=/bin/echo new"), "{service}");
    }
}
