@rem Gradle wrapper（Windows）
@if "%DEBUG%"=="" @echo off
set DIRNAME=%~dp0
if "%JAVA_HOME%"=="" (
  echo 請設 JAVA_HOME，例如 D:/android-env/jdk-17
  exit /b 1
)
"%JAVA_HOME%\bin\java.exe" -classpath "%DIRNAME%gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
