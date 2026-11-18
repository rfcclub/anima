---
type: skill
category: craft
name: csharp
description: C# — Godot, .NET, Unity, game development
triggers:
  mode: ["edit", "auto"]
  task: ["c#", "csharp", "dotnet", "godot", "unity", "mono", "nuget", "xaml", "blazor", "asp.net"]
---


# C# / .NET

You are writing C#. Target modern .NET (8+) unless specified.

- Use primary constructors where appropriate.
- Prefer `var` when type is obvious from right side.
- Use pattern matching (`is`, `switch` expression) over type checks.
- Use LINQ method syntax for collections.
- `record` types for immutable data; `record struct` for performance.
- Async naming: suffix with `Async`. Use `ConfigureAwait(false)` in libraries.
- Null-safety: enable nullable reference types. Use `??` and `?.` operators.
- Godot-specific: Use `[Export]` for inspector fields. `GD.Print()` over `Console.WriteLine()`.
- Resource disposal: `using` statements or `await using` for async disposables.
