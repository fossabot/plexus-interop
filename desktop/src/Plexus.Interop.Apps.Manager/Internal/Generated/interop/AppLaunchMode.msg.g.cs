// <auto-generated>
//     Generated by the protocol buffer compiler.  DO NOT EDIT!
//     source: interop/app_launch_mode.proto
// </auto-generated>
#pragma warning disable 1591, 0612, 3021
#region Designer generated code

using pb = global::Google.Protobuf;
using pbc = global::Google.Protobuf.Collections;
using pbr = global::Google.Protobuf.Reflection;
using scg = global::System.Collections.Generic;
namespace Plexus.Interop.Apps.Internal.Generated {

  /// <summary>Holder for reflection information generated from interop/app_launch_mode.proto</summary>
  internal static partial class AppLaunchModeReflection {

    #region Descriptor
    /// <summary>File descriptor for interop/app_launch_mode.proto</summary>
    public static pbr::FileDescriptor Descriptor {
      get { return descriptor; }
    }
    private static pbr::FileDescriptor descriptor;

    static AppLaunchModeReflection() {
      byte[] descriptorData = global::System.Convert.FromBase64String(
          string.Concat(
            "Ch1pbnRlcm9wL2FwcF9sYXVuY2hfbW9kZS5wcm90bxIHaW50ZXJvcBoVaW50",
            "ZXJvcC9vcHRpb25zLnByb3RvKjgKDUFwcExhdW5jaE1vZGUSEwoPU0lOR0xF",
            "X0lOU1RBTkNFEAASEgoOTVVMVElfSU5TVEFOQ0UQAUIpqgImUGxleHVzLklu",
            "dGVyb3AuQXBwcy5JbnRlcm5hbC5HZW5lcmF0ZWRiBnByb3RvMw=="));
      descriptor = pbr::FileDescriptor.FromGeneratedCode(descriptorData,
          new pbr::FileDescriptor[] { global::Plexus.Interop.Apps.Internal.Generated.OptionsReflection.Descriptor, },
          new pbr::GeneratedClrTypeInfo(new[] {typeof(global::Plexus.Interop.Apps.Internal.Generated.AppLaunchMode), }, null));
    }
    #endregion

  }
  #region Enums
  internal enum AppLaunchMode {
    [pbr::OriginalName("SINGLE_INSTANCE")] SingleInstance = 0,
    [pbr::OriginalName("MULTI_INSTANCE")] MultiInstance = 1,
  }

  #endregion

}

#endregion Designer generated code
