// Без консольного вікна в релізній збірці.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    court_analyzer_lib::run()
}
